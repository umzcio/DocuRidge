import { NextResponse } from 'next/server';
import { authenticateApiRequest, requireScope, type ApiAuthResult } from './auth';
import { checkRateLimit } from '../ratelimit';

export type ApiGuard =
  | { ok: true; auth: Extract<ApiAuthResult, { ok: true }> }
  | { ok: false; response: NextResponse };

/**
 * Shared front door for every /api/v1 route: bearer-token auth, scope check,
 * then an in-DB rate limit keyed on the token id.
 *
 * The Action union in src/lib/ratelimit.ts is frozen by a unit test, so API
 * traffic reuses existing buckets — a deliberate semantic stretch:
 *   - reads  → `share_view`   (per-token read traffic resembles share-link views)
 *   - writes → `bulk_send_create` (template sends through the API are bulk-send-grade)
 */
export async function guardApiRequest(
  req: Request,
  kind: 'read' | 'write',
): Promise<ApiGuard> {
  const auth = await authenticateApiRequest(req);
  if (!auth.ok) {
    return { ok: false, response: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  }

  const scopeErr = requireScope(auth, kind === 'read' ? 'read' : 'write');
  if (scopeErr) {
    return { ok: false, response: NextResponse.json({ error: scopeErr.error }, { status: scopeErr.status }) };
  }

  // Semantic stretch — see doc comment above.
  const action = kind === 'read' ? 'share_view' : 'bulk_send_create';
  const limit = await checkRateLimit(`api:${auth.token.id}`, action);
  if (!limit.allowed) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Rate limit exceeded. Retry after the current window rolls over.' },
        { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
      ),
    };
  }

  return { ok: true, auth };
}

export function notFoundJson(message = 'Not found.'): NextResponse {
  return NextResponse.json({ error: message }, { status: 404 });
}
