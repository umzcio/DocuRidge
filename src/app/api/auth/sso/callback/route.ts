import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getEnv, getBasePath } from '@/lib/env';
import { timingSafeEqual } from '@/lib/util';
import { childLogger } from '@/lib/logger';
import { captureClientContext, createSession } from '@/lib/auth/session';
import { recordUserSecurityEvent } from '@/lib/audit/user-security';
import {
  discoverIssuer,
  exchangeCode,
  fetchUserInfo,
  isTrustedSsoIssuer,
  OIDC_STATE_COOKIE,
  resolveSsoUser,
  type OidcStatePayload,
} from '@/lib/auth/oidc';

export const dynamic = 'force-dynamic';

/**
 * OIDC callback. Verifies the state cookie against the returned state,
 * exchanges the code, resolves the identity, JIT-provisions (or links) the
 * user, creates the standard app session, and lands on /dashboard. Every
 * failure — malformed state, bad code, deleted/conflicting account — collapses
 * to the same /login?sso=error redirect so the flow leaks nothing.
 */
export async function GET(req: NextRequest) {
  const log = childLogger({ route: 'sso_callback' });
  const env = getEnv();
  const basePath = getBasePath();
  const fail = () => NextResponse.redirect(new URL('/login?sso=error', env.PUBLIC_URL), 302);

  const rawCookie = req.cookies.get(OIDC_STATE_COOKIE)?.value;
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  if (!rawCookie || !code || !state) return fail();

  let stored: OidcStatePayload;
  try {
    stored = JSON.parse(rawCookie) as OidcStatePayload;
  } catch {
    return fail();
  }
  if (typeof stored.state !== 'string' || !timingSafeEqual(stored.state, state)) {
    return fail();
  }

  const org = await prisma.organisation.findUnique({ where: { id: stored.orgId } });
  if (!org?.ssoEnabled || !org.ssoIssuer || !org.ssoClientId || !org.ssoClientSecret) {
    return fail();
  }
  if (!isTrustedSsoIssuer(org.ssoIssuer, env.SSO_TRUSTED_ISSUERS)) {
    log.warn({ orgId: org.id }, 'SSO callback refused — issuer not in SSO_TRUSTED_ISSUERS');
    return fail();
  }

  try {
    const endpoints = await discoverIssuer(org.ssoIssuer);
    const redirectUri = `${env.PUBLIC_URL}/api/auth/sso/callback`;
    const { accessToken } = await exchangeCode(
      {
        tokenEndpoint: endpoints.tokenEndpoint,
        clientId: org.ssoClientId,
        clientSecret: org.ssoClientSecret,
      },
      code,
      redirectUri,
    );
    const info = await fetchUserInfo(endpoints.userinfoEndpoint, accessToken);

    const { userId } = await resolveSsoUser(prisma)({
      sub: info.sub,
      email: info.email,
      name: info.name,
      orgId: org.id,
    });

    const { ipAddress, userAgent } = captureClientContext(req.headers);
    await createSession({ userId, orgId: org.id, ipAddress, userAgent });
    await prisma.user.update({
      where: { id: userId },
      data: { lastSignedInAt: new Date() },
    });
    await recordUserSecurityEvent({
      userId,
      type: 'login_succeeded',
      ipAddress,
      userAgent,
      data: { method: 'oidc_sso', orgId: org.id },
    });

    const res = NextResponse.redirect(new URL('/dashboard', env.PUBLIC_URL), 302);
    res.cookies.set(OIDC_STATE_COOKIE, '', { maxAge: 0, path: basePath || '/' });
    return res;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId: org.id },
      'SSO callback failed',
    );
    return fail();
  }
}
