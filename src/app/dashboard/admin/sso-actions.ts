'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { can } from '@/lib/authz/can';
import { childLogger } from '@/lib/logger';
import { parseHostAllowlist, vetOutboundUrl } from '@/lib/net/outbound';
import { getEnv } from '@/lib/env';
import { isSsoIssuerBoundToOrg } from '@/lib/auth/oidc';

const DEFAULT_SCOPES = 'openid profile email';

const SsoConfigSchema = z.object({
  ssoEnabled: z.boolean().default(false),
  ssoIssuer: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || (z.string().url().safeParse(v).success && v.startsWith('https://')), {
      message: 'Issuer must be an https URL',
    }),
  ssoClientId: z.string().trim().max(300),
  ssoClientSecret: z.string().max(500),
  ssoScopes: z.string().trim().max(300).default(DEFAULT_SCOPES),
});

export interface SsoConfigActionState {
  ok: boolean;
  error?: string;
  success?: string;
  fieldErrors?: Record<string, string>;
}

/**
 * Save the org's OIDC IdP configuration. Admin-gated like branding. An empty
 * client secret means "keep the stored one" (the secret is never rendered
 * back into the form). There is no org-level admin audit module — the change
 * is logged with before/after visibility instead.
 */
export async function saveSsoConfigAction(
  _prev: SsoConfigActionState,
  formData: FormData,
): Promise<SsoConfigActionState> {
  const log = childLogger({ action: 'sso_config_update' });
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };
  if (!can({ userId: session.user.id, orgId: session.orgId, role: session.role }, 'org:update_settings', { orgId: session.orgId })) {
    return { ok: false, error: 'Only org admins can manage SSO.' };
  }

  const parsed = SsoConfigSchema.safeParse({
    ssoEnabled: formData.get('ssoEnabled') === 'on',
    ssoIssuer: String(formData.get('ssoIssuer') ?? ''),
    ssoClientId: String(formData.get('ssoClientId') ?? ''),
    ssoClientSecret: String(formData.get('ssoClientSecret') ?? ''),
    ssoScopes: String(formData.get('ssoScopes') ?? '') || DEFAULT_SCOPES,
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.errors) {
      fieldErrors[String(issue.path[0])] = issue.message;
    }
    return { ok: false, fieldErrors, error: 'Please fix the highlighted fields.' };
  }

  const { ssoEnabled, ssoIssuer, ssoClientId, ssoClientSecret, ssoScopes } = parsed.data;
  const fieldErrors: Record<string, string> = {};

  const org = await prisma.organisation.findUnique({ where: { id: session.orgId } });
  if (!org) return { ok: false, error: 'Organisation not found.' };

  // The operator binds each trusted issuer to one org slug. Refuse any issuer
  // not bound to THIS org, enabled or not — otherwise any self-registered
  // admin could save a trusted IdP with their own client and capture its
  // users. Login, callback and provisioning re-check the binding at use time.
  if (ssoIssuer && !isSsoIssuerBoundToOrg({ slug: org.slug, ssoIssuer }, getEnv().SSO_TRUSTED_ISSUERS)) {
    fieldErrors.ssoIssuer =
      'This issuer is not bound to this organisation by the deployment (SSO_TRUSTED_ISSUERS). Ask the operator to add it.';
  }
  if (ssoEnabled) {
    if (!ssoIssuer) fieldErrors.ssoIssuer = 'Issuer is required when SSO is enabled.';
    if (!ssoClientId) fieldErrors.ssoClientId = 'Client ID is required when SSO is enabled.';
    if (ssoClientSecret && ssoClientSecret.length < 8) {
      fieldErrors.ssoClientSecret = 'Client secret must be at least 8 characters.';
    }
  }
  if (!fieldErrors.ssoIssuer && ssoIssuer) {
    // The server fetches this issuer's metadata (and the endpoints it names),
    // so refuse an issuer that resolves inside the network. Re-checked on
    // every fetch by ssoFetch.
    const target = await vetOutboundUrl(ssoIssuer, {
      allowedInternalHosts: parseHostAllowlist(process.env.SSO_ALLOWED_INTERNAL_HOSTS),
    });
    if (!target.ok) {
      log.warn({ orgId: session.orgId, reason: target.reason }, 'SSO issuer refused');
      fieldErrors.ssoIssuer =
        target.reason === 'unresolvable'
          ? 'Issuer host could not be resolved.'
          : 'Issuer must be a public host — internal and loopback addresses are refused.';
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors, error: 'Please fix the highlighted fields.' };
  }

  // Secret policy: a blank field keeps the stored value; only a non-empty
  // entry replaces it. Enabling requires one to exist (stored or supplied).
  const hasSecret = Boolean(org.ssoClientSecret) || ssoClientSecret.length > 0;
  if (ssoEnabled && !hasSecret) {
    return {
      ok: false,
      fieldErrors: { ssoClientSecret: 'Client secret is required when SSO is enabled.' },
      error: 'Please fix the highlighted fields.',
    };
  }

  await prisma.organisation.update({
    where: { id: session.orgId },
    data: {
      ssoEnabled,
      ssoIssuer: ssoIssuer || null,
      ssoClientId: ssoClientId || null,
      ...(ssoClientSecret ? { ssoClientSecret } : {}),
      ssoScopes,
    },
  });

  log.info(
    {
      orgId: session.orgId,
      adminUserId: session.user.id,
      ssoEnabled,
      ssoIssuer: ssoIssuer || null,
      ssoClientId: ssoClientId ? '[set]' : null,
      ssoSecretRotated: ssoClientSecret.length > 0,
    },
    'SSO configuration updated',
  );

  revalidatePath('/dashboard/admin');
  return {
    ok: true,
    success: ssoEnabled
      ? 'SSO saved. The "Sign in with SSO" button now appears on the login page.'
      : 'SSO disabled. The login page no longer offers SSO.',
  };
}
