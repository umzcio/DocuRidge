import { z } from 'zod';

/**
 * Minimal OIDC client for the per-org SSO flow (Entra-ready).
 *
 * PKCE is deliberately deferred: Entra accepts the confidential-client auth
 * code flow without it because the client secret never reaches the browser.
 * Follow-up hardening: add an S256 code challenge to buildAuthorizeUrl and
 * carry the verifier in the state cookie.
 *
 * The client secret is stored on Organisation.ssoClientSecret (writable by
 * org admins only — see sso-actions.ts). Hardening path: an
 * SSO_CLIENT_SECRET_<ORGSLUG> env override checked before the DB value, so
 * secrets can live entirely outside the database (see src/lib/env.ts for the
 * env module pattern).
 */

export interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
}

export interface OidcClientConfig extends OidcEndpoints {
  clientId: string;
  clientSecret: string;
  scopes: string;
}

/** Name of the short-lived HttpOnly cookie carrying state + nonce + orgId. */
export const OIDC_STATE_COOKIE = 'dr_oidc_state';

export const OIDC_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;

export interface OidcStatePayload {
  state: string;
  nonce: string;
  orgId: string;
}

/** Injectable fetch so unit tests can stub the wire. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DiscoverySchema = z.object({
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  userinfo_endpoint: z.string().url(),
});

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  id_token: z.string().min(1),
});

const UserInfoSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  name: z.string().optional(),
});

/** GET `${issuer}/.well-known/openid-configuration` and parse the endpoints. */
export async function discoverIssuer(
  issuer: string,
  fetchImpl: FetchLike = fetch,
): Promise<OidcEndpoints> {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Issuer discovery failed: HTTP ${res.status}`);
  }
  const parsed = DiscoverySchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error('Issuer discovery returned malformed metadata');
  }
  return {
    authorizationEndpoint: parsed.data.authorization_endpoint,
    tokenEndpoint: parsed.data.token_endpoint,
    userinfoEndpoint: parsed.data.userinfo_endpoint,
  };
}

/** Build the IdP authorization redirect (response_type=code, URLSearchParams-encoded). */
export function buildAuthorizeUrl(
  cfg: Pick<OidcClientConfig, 'authorizationEndpoint' | 'clientId' | 'scopes'>,
  opts: { state: string; nonce: string; redirectUri: string },
): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    scope: cfg.scopes,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    nonce: opts.nonce,
  });
  return `${cfg.authorizationEndpoint}?${params.toString()}`;
}

/** Exchange the authorization code at the token endpoint (basic-auth client). */
export async function exchangeCode(
  cfg: Pick<OidcClientConfig, 'tokenEndpoint' | 'clientId' | 'clientSecret'>,
  code: string,
  redirectUri: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ accessToken: string; idToken: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const credentials = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const res = await fetchImpl(cfg.tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${credentials}`,
      accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: HTTP ${res.status}`);
  }
  const parsed = TokenResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error('Token endpoint returned a malformed response');
  }
  return { accessToken: parsed.data.access_token, idToken: parsed.data.id_token };
}

/** GET the UserInfo endpoint with the access token; zod-validate sub/email/name. */
export async function fetchUserInfo(
  endpoint: string,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ sub: string; email: string; name?: string }> {
  const res = await fetchImpl(endpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`UserInfo failed: HTTP ${res.status}`);
  }
  const parsed = UserInfoSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error('UserInfo returned a malformed response');
  }
  return parsed.data;
}

/* ─── JIT provisioning ─────────────────────────────────────────────── */

export type SsoResolution = 'linked' | 'matched' | 'created';

export interface SsoUserRecord {
  id: string;
  email: string;
  name: string;
  ssoSubject: string | null;
  ssoOrgId: string | null;
  emailVerifiedAt: Date | null;
  deletedAt: Date | null;
}

/**
 * Narrow prisma-shaped delegate so vitest can inject a mock without a DB.
 * The real PrismaClient satisfies this structurally at the call sites.
 */
export interface SsoResolveDb {
  user: {
    findFirst(args: {
      where: { ssoSubject: string; ssoOrgId: string };
    }): Promise<SsoUserRecord | null>;
    findUnique(args: { where: { email: string } }): Promise<SsoUserRecord | null>;
    update(args: {
      where: { id: string };
      data: { ssoSubject: string; ssoOrgId: string; emailVerifiedAt?: Date };
    }): Promise<SsoUserRecord>;
    create(args: {
      data: {
        email: string;
        name: string;
        passwordHash: null;
        emailVerifiedAt: Date;
        ssoSubject: string;
        ssoOrgId: string;
      };
    }): Promise<SsoUserRecord>;
  };
  orgMember: {
    findUnique(args: {
      where: { orgId_userId: { orgId: string; userId: string } };
    }): Promise<{ id: string } | null>;
    create(args: {
      data: { orgId: string; userId: string; role: 'SENDER' };
    }): Promise<{ id: string }>;
  };
}

/**
 * Map an authenticated OIDC identity onto a local user, JIT-provisioning
 * when necessary. Returns which path was taken:
 *
 *  - 'linked'  — user already bound to (ssoSubject, ssoOrgId)
 *  - 'matched' — existing personal account linked by email on first SSO use
 *  - 'created' — brand-new SSO-only user + OrgMember
 *
 * Throws on: deleted accounts, an email already bound to a DIFFERENT SSO
 * subject (never silently rebind), and an email match outside the org
 * (no silent cross-org membership grants).
 */
export function resolveSsoUser(db: SsoResolveDb) {
  return async (args: {
    sub: string;
    email: string;
    orgId: string;
    name?: string;
  }): Promise<{ status: SsoResolution; userId: string }> => {
    const email = args.email.trim().toLowerCase();

    const linked = await db.user.findFirst({
      where: { ssoSubject: args.sub, ssoOrgId: args.orgId },
    });
    if (linked) {
      if (linked.deletedAt) throw new Error('sso_user_deleted');
      return { status: 'linked', userId: linked.id };
    }

    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      if (existing.deletedAt) throw new Error('sso_user_deleted');
      if (existing.ssoSubject && existing.ssoSubject !== args.sub) {
        throw new Error('sso_subject_conflict');
      }
      const membership = await db.orgMember.findUnique({
        where: { orgId_userId: { orgId: args.orgId, userId: existing.id } },
      });
      if (!membership) throw new Error('sso_email_not_in_org');
      await db.user.update({
        where: { id: existing.id },
        data: {
          ssoSubject: args.sub,
          ssoOrgId: args.orgId,
          emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
        },
      });
      return { status: 'matched', userId: existing.id };
    }

    // JIT-provision an SSO-only account. Provisioned staff get SENDER (the
    // org's default member role); org ADMIN is assigned out-of-band, matching
    // how registration reserves ADMIN for the org creator.
    const name = args.name?.trim() || email.split('@')[0] || email;
    const created = await db.user.create({
      data: {
        email,
        name,
        passwordHash: null,
        emailVerifiedAt: new Date(),
        ssoSubject: args.sub,
        ssoOrgId: args.orgId,
      },
    });
    await db.orgMember.create({
      data: { orgId: args.orgId, userId: created.id, role: 'SENDER' },
    });
    return { status: 'created', userId: created.id };
  };
}
