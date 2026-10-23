import { prisma } from '@/lib/prisma';
import { boundSsoOrgSlugs, isSsoIssuerBoundToOrg } from './sso-bindings';

export interface SsoLoginOrg {
  id: string;
  slug: string;
  name: string;
  ssoIssuer: string;
  ssoClientId: string;
  ssoScopes: string;
}

/**
 * The orgs that may offer "Sign in with SSO": SSO enabled, a client ID set,
 * and an issuer that SSO_TRUSTED_ISSUERS binds to that org's slug. Only the
 * operator's bindings pick the candidates — never creation order — so a newer
 * self-registered org can't take over the button. Sorted by name for a stable
 * login page.
 */
export async function findBoundSsoOrgs(trustedIssuers: string): Promise<SsoLoginOrg[]> {
  const slugs = boundSsoOrgSlugs(trustedIssuers);
  if (slugs.length === 0) return [];
  const rows = await prisma.organisation.findMany({
    where: { slug: { in: slugs }, ssoEnabled: true, ssoClientId: { not: null } },
    select: { id: true, slug: true, name: true, ssoIssuer: true, ssoClientId: true, ssoScopes: true },
    orderBy: { name: 'asc' },
  });
  return rows.filter(
    (o): o is SsoLoginOrg =>
      Boolean(o.ssoClientId) && isSsoIssuerBoundToOrg(o, trustedIssuers),
  );
}
