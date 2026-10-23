import { NextRequest, NextResponse } from 'next/server';

/**
 * Build an absolute redirect URL from the actual request headers so we
 * never bounce a client to the wrong origin. In the standalone server
 * `req.url` carries the internal HOSTNAME (`0.0.0.0`) — using it for
 * browser-facing redirects would send users to whatever happens to listen
 * on that port of their own machine. Behind nginx, `x-forwarded-*` carry
 * the public origin; in direct local access the plain `host` header does.
 *
 * Extracted from (auth)/verify/route.ts, which established this pattern.
 */
export function requestOrigin(req: NextRequest | Request): string {
  const h = req.headers;
  const nextUrl = req instanceof NextRequest ? req.nextUrl : null;
  const proto =
    h.get('x-forwarded-proto') ||
    nextUrl?.protocol.replace(':', '') ||
    'http';
  const host =
    h.get('x-forwarded-host') ||
    h.get('host') ||
    nextUrl?.host ||
    'localhost';
  return `${proto}://${host}`;
}

/** 302 redirect to `path` (which must include the basePath) on the request's origin. */
export function redirectTo(req: NextRequest | Request, path: string, status = 302): NextResponse {
  return NextResponse.redirect(`${requestOrigin(req)}${path}`, status);
}
