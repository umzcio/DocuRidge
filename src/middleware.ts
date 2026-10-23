import { NextRequest, NextResponse } from 'next/server';

/**
 * Edge middleware. Two responsibilities:
 *
 *   1. Request ID propagation — every response carries an x-request-id so
 *      logs can be correlated.
 *
 *   2. Origin allowlist for state-changing requests.
 *
 * Server Actions in Next.js 15 already validate Origin against
 * `experimental.serverActions.allowedOrigins` in next.config.js — that is
 * the canonical CSRF defense for App Router POSTs. This middleware is a
 * defense-in-depth check that rejects clearly-bogus origins (e.g. an
 * Origin from a third party). Empty/null Origin (same-origin form
 * navigation) is allowed since Next will validate the action ref.
 */

function originIsAllowed(origin: string): boolean {
  // Trust the public URL origin.
  const publicUrl = process.env.PUBLIC_URL;
  if (publicUrl) {
    try {
      if (new URL(publicUrl).origin === origin) return true;
    } catch {
      // ignore malformed PUBLIC_URL
    }
  }
  // Additional trusted origins for alternate front doors that reach the same
  // app (e.g. a Tailscale `tailscale serve` hostname, which forwards its own
  // Host/Origin and therefore never matches PUBLIC_URL). Comma-separated
  // absolute origins — scheme + host + optional port, no path.
  // PUBLIC_URL stays canonical: emailed links are still built from it.
  for (const extra of (process.env.TRUSTED_ORIGINS ?? '').split(',')) {
    const trimmed = extra.trim();
    // Guard against an empty/whitespace-only entry matching a null origin.
    if (trimmed && trimmed === origin) return true;
  }
  // Loopback always permitted (local dev, Playwright).
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0') {
      return true;
    }
    // Internal docker network (in-network tests).
    if (u.hostname === 'docuridge_app') return true;
  } catch {
    // not a parseable origin → fall through
  }
  return false;
}

export function middleware(req: NextRequest) {
  const reqId = req.headers.get('x-request-id') || crypto.randomUUID();

  // REST API v1 routes authenticate via bearer token (no cookies), so the
  // Origin allowlist below — a CSRF defense for cookie-based server actions —
  // does not apply. Server-to-server clients may send any Origin (or none).
  // Request-ID propagation still applies.
  if (req.nextUrl.pathname.startsWith('/api/v1/')) {
    const res = NextResponse.next({
      request: { headers: new Headers(req.headers) },
    });
    res.headers.set('x-request-id', reqId);
    return res;
  }

  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);

  if (isMutation) {
    const origin = req.headers.get('origin');
    if (origin && !originIsAllowed(origin)) {
      return new NextResponse('Bad Origin', { status: 403 });
    }
  }

  const res = NextResponse.next({
    request: { headers: new Headers(req.headers) },
  });
  res.headers.set('x-request-id', reqId);
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
