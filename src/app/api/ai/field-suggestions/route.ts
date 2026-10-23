import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/authz/can';
import { checkRateLimit } from '@/lib/ratelimit';
import { MAX_PAGE_REQUEST_BYTES, pageSuggestionRequestSchema } from '@/lib/ai/field-suggestions';
import { AiSuggestionError, BodyTooLargeError, getAiConfiguration, readBoundedJson, suggestPageFields } from '@/lib/ai/provider';

export const runtime = 'nodejs';

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

async function access() {
  const session = await getSession();
  if (!session) return { error: json({ error: 'Sign in to use AI field suggestions.' }, 401) };
  if (!can({ userId: session.user.id, orgId: session.orgId, role: session.role }, 'envelope:create')) {
    return { error: json({ error: 'You do not have permission to prepare envelopes.' }, 403) };
  }
  return { session };
}

/** Route-level CSRF is strict: no missing/null origins or implicit loopback trust. */
function trustedOrigin(origin: string | null): boolean {
  if (!origin || origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) return false;
    const publicUrl = process.env.PUBLIC_URL;
    if (publicUrl && new URL(publicUrl).origin === origin) return true;
    return (process.env.TRUSTED_ORIGINS ?? '').split(',').some((value) => value.trim() === origin);
  } catch { return false; }
}

export async function GET() {
  try {
    const authorized = await access();
    if (authorized.error) return authorized.error;
    return json({ enabled: getAiConfiguration() !== null });
  } catch { return json({ error: 'Unable to check AI availability.' }, 503); }
}

export async function POST(request: Request) {
  try {
    const authorized = await access();
    if (authorized.error) return authorized.error;
    if (!trustedOrigin(request.headers.get('origin'))) return json({ error: 'Untrusted request origin.' }, 403);
    if (!getAiConfiguration()) return json({ error: 'AI field suggestions are disabled. Ask an administrator to configure DOCURIDGE_AI_BASE_URL and DOCURIDGE_AI_MODEL.' }, 503);
    const { session } = authorized;
    const limit = await checkRateLimit(`ai:${session.orgId}:${session.user.id}`, 'ai_field_suggestions');
    if (!limit.allowed) return json({ error: 'Too many AI requests. Wait before retrying this page.' }, 429, { 'Retry-After': String(limit.retryAfterSeconds) });
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return json({ error: 'Send a JSON page request.' }, 415);
    }
    let raw: unknown;
    try { raw = await readBoundedJson(request, MAX_PAGE_REQUEST_BYTES, request.signal); }
    catch (error) {
      if (request.signal.aborted) return json({ error: 'Analysis cancelled.' }, 499);
      if (error instanceof BodyTooLargeError) return json({ error: 'Page image is too large. Use a smaller preview.' }, 413);
      return json({ error: 'Invalid JSON page request.' }, 400);
    }
    const parsed = pageSuggestionRequestSchema.safeParse(raw);
    if (!parsed.success) return json({ error: 'Invalid page image, text, or page number.' }, 400);
    return json({ suggestions: await suggestPageFields(parsed.data, request.signal) });
  } catch (error) {
    if (error instanceof AiSuggestionError) return json({ error: error.message }, error.status);
    return json({ error: 'AI suggestions are temporarily unavailable.' }, 503);
  }
}
