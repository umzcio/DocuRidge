/**
 * SSO_TRUSTED_ISSUERS parsing. Kept free of imports so src/lib/env.ts can
 * validate the value at boot; re-exported from ./oidc.
 */

/** One operator-set SSO_TRUSTED_ISSUERS entry: this org may use this issuer. */
export interface SsoIssuerBinding {
  orgSlug: string;
  issuer: string;
}

export interface ParsedSsoIssuerBindings {
  bindings: SsoIssuerBinding[];
  /** Entries that were dropped, each with the reason (surfaced by env validation). */
  invalid: { entry: string; reason: string }[];
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Parse SSO_TRUSTED_ISSUERS: comma-separated `<org-slug>=<issuer-url>`
 * entries, split on the first `=`. Fails closed: an entry without `=`, with
 * an empty slug, or with a non-https issuer is dropped, and every entry for a
 * slug listed more than once is dropped (the binding would be ambiguous).
 * src/lib/env.ts refuses to boot when any entry is dropped, so in a running
 * app `invalid` is empty; the filtering here is the backstop.
 */
export function parseSsoIssuerBindings(raw: string): ParsedSsoIssuerBindings {
  const candidates: SsoIssuerBinding[] = [];
  const invalid: ParsedSsoIssuerBindings['invalid'] = [];
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    if (eq === -1) {
      invalid.push({ entry, reason: 'expected <org-slug>=<issuer-url>' });
      continue;
    }
    const orgSlug = entry.slice(0, eq).trim();
    const issuer = entry.slice(eq + 1).trim();
    if (!orgSlug) {
      invalid.push({ entry, reason: 'missing org slug before "="' });
      continue;
    }
    if (!isHttpsUrl(issuer)) {
      invalid.push({ entry, reason: 'issuer must be an https URL' });
      continue;
    }
    candidates.push({ orgSlug, issuer });
  }

  const counts = new Map<string, number>();
  for (const b of candidates) counts.set(b.orgSlug, (counts.get(b.orgSlug) ?? 0) + 1);
  const bindings: SsoIssuerBinding[] = [];
  for (const b of candidates) {
    if (counts.get(b.orgSlug) === 1) bindings.push(b);
    else invalid.push({ entry: `${b.orgSlug}=${b.issuer}`, reason: `org slug "${b.orgSlug}" is bound more than once` });
  }
  return { bindings, invalid };
}

/**
 * Any org admin can point their org at an issuer, and SSO takes the issuer's
 * email claim as proof of mailbox ownership (see resolveSsoUser). Trusting
 * the issuer alone is not enough: open registration makes anyone an org
 * admin, and they could register their own client at a trusted IdP and
 * capture its users. So the operator binds each trusted issuer to the one org
 * allowed to use it, and SSO runs only for an org whose (slug, issuer) pair
 * is listed exactly in SSO_TRUSTED_ISSUERS.
 */
export function isSsoIssuerBoundToOrg(
  org: { slug: string; ssoIssuer: string | null },
  rawBindings: string,
): boolean {
  if (!org.slug || !org.ssoIssuer) return false;
  return parseSsoIssuerBindings(rawBindings).bindings.some(
    (b) => b.orgSlug === org.slug && b.issuer === org.ssoIssuer,
  );
}

/** Slugs of the orgs SSO_TRUSTED_ISSUERS binds to an issuer. */
export function boundSsoOrgSlugs(rawBindings: string): string[] {
  return parseSsoIssuerBindings(rawBindings).bindings.map((b) => b.orgSlug);
}
