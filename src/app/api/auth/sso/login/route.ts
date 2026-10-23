import { NextRequest, NextResponse } from 'next/server';
import { getEnv, getBasePath } from '@/lib/env';
import { randomBase64Url } from '@/lib/util';
import { childLogger } from '@/lib/logger';
import {
  buildAuthorizeUrl,
  discoverIssuer,
  OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE_MAX_AGE_SECONDS,
  type OidcStatePayload,
} from '@/lib/auth/oidc';
import { findBoundSsoOrgs } from '@/lib/auth/sso-orgs';

export const dynamic = 'force-dynamic';

/**
 * Start the OIDC flow for an org that SSO_TRUSTED_ISSUERS binds to its
 * issuer. The org comes from the operator's bindings, never from creation
 * order: with one bound, SSO-enabled org it is used; with several, the
 * `org=<slug>` query param must name one of them (the login page renders a
 * button per org). Discovers the IdP metadata, mints state + nonce, parks
 * them with the org's id, slug and issuer in a short-lived HttpOnly cookie,
 * and 302s to the IdP authorization endpoint. 404 when no such org.
 */
export async function GET(req: NextRequest) {
  const log = childLogger({ route: 'sso_login' });

  const env = getEnv();
  const orgs = await findBoundSsoOrgs(env.SSO_TRUSTED_ISSUERS);
  const requested = req.nextUrl.searchParams.get('org');

  let org: (typeof orgs)[number] | undefined;
  if (requested !== null) {
    org = orgs.find((o) => o.slug === requested);
  } else if (orgs.length === 1) {
    org = orgs[0];
  } else if (orgs.length > 1) {
    return new NextResponse('Choose your organisation from the sign-in page.', { status: 400 });
  }
  if (!org) {
    return new NextResponse('SSO is not enabled.', { status: 404 });
  }

  const redirectUri = `${env.PUBLIC_URL}/api/auth/sso/callback`;

  let authorizeUrl: string;
  try {
    const endpoints = await discoverIssuer(org.ssoIssuer);
    const payload: OidcStatePayload = {
      state: randomBase64Url(16),
      nonce: randomBase64Url(16),
      orgId: org.id,
      orgSlug: org.slug,
      issuer: org.ssoIssuer,
    };
    authorizeUrl = buildAuthorizeUrl(
      {
        authorizationEndpoint: endpoints.authorizationEndpoint,
        clientId: org.ssoClientId,
        scopes: org.ssoScopes,
      },
      { state: payload.state, nonce: payload.nonce, redirectUri },
    );

    const res = NextResponse.redirect(authorizeUrl, 302);
    res.cookies.set(OIDC_STATE_COOKIE, JSON.stringify(payload), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: OIDC_STATE_COOKIE_MAX_AGE_SECONDS,
      path: getBasePath() || '/',
    });
    return res;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId: org.id },
      'SSO login failed to start',
    );
    return NextResponse.redirect(new URL('/login?sso=error', env.PUBLIC_URL), 302);
  }
}
