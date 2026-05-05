import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashToken, verifyToken } from '@/lib/auth/tokens';
import { recordUserSecurityEvent } from '@/lib/audit/user-security';
import { childLogger } from '@/lib/logger';
import { getClientIp } from '@/lib/util';

function redirectFromRequest(req: NextRequest, path: string): NextResponse {
  // Build an absolute redirect URL from the actual request headers so we
  // never bounce a local-dev / test client to PUBLIC_URL by accident.
  const proto = req.headers.get('x-forwarded-proto') || req.nextUrl.protocol.replace(':', '') || 'http';
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || req.nextUrl.host;
  return NextResponse.redirect(`${proto}://${host}${path}`, 303);
}

/**
 * GET /verify?token=...
 *
 * Consumes an email-verification token. Successful → marks emailVerifiedAt,
 * marks the row consumed, redirects to /login?verified=1.
 * Failure → renders a small error page (HTML inline; no JS dependencies).
 */
export async function GET(req: NextRequest) {
  const log = childLogger({ route: 'verify' });
  const url = new URL(req.url);
  const token = url.searchParams.get('token');

  if (!token) {
    return errorPage('Missing token.', 400);
  }

  const verified = await verifyToken(token, 'email_verification');
  if (!verified) {
    log.info({ ipAddress: getClientIp(req.headers) }, 'verify token failed signature/exp check');
    return errorPage('Verification link is invalid or has expired.', 400);
  }

  const tokenHash = await hashToken(token);
  const row = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash },
  });
  if (!row) {
    log.info({ userId: verified.userId }, 'verify token not found in DB');
    return errorPage('Verification link is invalid or has expired.', 400);
  }
  if (row.consumedAt) {
    return errorPage('This verification link has already been used.', 400);
  }
  if (row.expiresAt.getTime() < Date.now()) {
    return errorPage('This verification link has expired.', 400);
  }

  // Consume + mark verified atomically.
  await prisma.$transaction([
    prisma.emailVerificationToken.update({
      where: { tokenHash },
      data: { consumedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: verified.userId },
      data: { emailVerifiedAt: new Date() },
    }),
  ]);

  await recordUserSecurityEvent({
    userId: verified.userId,
    type: 'email_verified',
    ipAddress: getClientIp(req.headers),
    userAgent: req.headers.get('user-agent') ?? 'unknown',
  });
  log.info({ userId: verified.userId }, 'email verified');

  return redirectFromRequest(req, '/DocuRidge/login?verified=1');
}

function errorPage(message: string, status: number): NextResponse {
  const body = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<title>Verification failed — DocuRidge</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{font:14px system-ui,sans-serif;color:#1f2937;background:#f5f5f5;margin:0;padding:2rem;display:flex;justify-content:center;align-items:center;min-height:100vh}
  .card{background:#fff;border:1px solid #e5e5e5;border-radius:.5rem;padding:1.5rem 2rem;max-width:28rem}
  h1{margin:0 0 .5rem;font-size:1.125rem}
  a{color:#265558}
</style></head>
<body><div class="card">
  <h1>Verification failed</h1>
  <p>${escapeHtml(message)}</p>
  <p><a href="/DocuRidge/login">Return to sign in</a></p>
</div></body></html>`;
  return new NextResponse(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
