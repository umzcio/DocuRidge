import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
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

export const dynamic = 'force-dynamic';

/**
 * Start the OIDC flow for the SSO-enabled org (the most recently created one,
 * matching v1's single-IdP assumption). Discovers the IdP metadata, mints
 * state + nonce, parks them in a short-lived HttpOnly cookie, and 302s to the
 * IdP authorization endpoint. 404 when no org has SSO enabled.
 */
export async function GET() {
  const log = childLogger({ route: 'sso_login' });

  const org = await prisma.organisation.findFirst({
    where: { ssoEnabled: true, ssoIssuer: { not: null }, ssoClientId: { not: null } },
    orderBy: { createdAt: 'desc' },
  });
  if (!org?.ssoIssuer || !org.ssoClientId) {
    return new NextResponse('SSO is not enabled.', { status: 404 });
  }

  const env = getEnv();
  const redirectUri = `${env.PUBLIC_URL}/api/auth/sso/callback`;

  let authorizeUrl: string;
  try {
    const endpoints = await discoverIssuer(org.ssoIssuer);
    const payload: OidcStatePayload = {
      state: randomBase64Url(16),
      nonce: randomBase64Url(16),
      orgId: org.id,
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
