import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { session, rateLimit } = vi.hoisted(() => ({ session: vi.fn(), rateLimit: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({ getSession: session }));
vi.mock('@/lib/ratelimit', () => ({ checkRateLimit: rateLimit }));
import { GET, POST } from './route';
import { MAX_PAGE_REQUEST_BYTES } from '@/lib/ai/field-suggestions';

const payload = { image: 'data:image/jpeg;base64,/9j/2Q==', text: '', page: 1 };
function request(origin: string | null = 'https://docs.example', body: unknown = payload) {
  return new Request('http://internal/api/ai/field-suggestions', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin === null ? {} : { origin }) }, body: JSON.stringify(body) });
}
describe('AI field suggestion route', () => {
  beforeEach(() => {
    session.mockResolvedValue({ user: { id: 'u1' }, orgId: 'o1', role: 'SENDER' });
    rateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 10 });
    vi.stubEnv('PUBLIC_URL', 'https://docs.example/DocuRidge');
    vi.stubEnv('TRUSTED_ORIGINS', 'https://alternate.example');
    vi.stubEnv('DOCURIDGE_AI_BASE_URL', 'https://provider.example/v1');
    vi.stubEnv('DOCURIDGE_AI_MODEL', 'vision-test');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"suggestions":[]}' } }] })));
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
  it('requires a session for discovery and analysis', async () => {
    session.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await POST(request())).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('denies VIEWER permission for discovery and analysis', async () => {
    session.mockResolvedValue({ user: { id: 'u1' }, orgId: 'o1', role: 'VIEWER' });
    expect((await GET()).status).toBe(403);
    expect((await POST(request())).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([null, 'null', 'https://evil.example', 'https://docs.example.evil.example', 'https://docs.example/path', 'http://localhost:3000'])('rejects untrusted or missing origin %s', async (origin) => {
    expect((await POST(request(origin))).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['https://docs.example', 'https://alternate.example'])('accepts an explicitly trusted origin %s', async (origin) => {
    const result = await POST(request(origin));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ suggestions: [] });
  });
  it('advertises availability without exposing server configuration and disables analysis when missing', async () => {
    expect(await (await GET()).json()).toEqual({ enabled: true });
    vi.stubEnv('DOCURIDGE_AI_MODEL', '');
    expect(await (await GET()).json()).toEqual({ enabled: false });
    expect((await POST(request())).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('enforces a user/org rate limit before provider requests', async () => {
    rateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 17 });
    const result = await POST(request());
    expect(result.status).toBe(429);
    expect(result.headers.get('retry-after')).toBe('17');
    expect(rateLimit).toHaveBeenCalledWith('ai:o1:u1', 'ai_field_suggestions');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects malformed requests and unsupported content types', async () => {
    expect((await POST(request(undefined, { ...payload, image: 'https://evil.example' }))).status).toBe(400);
    const invalid = request(); invalid.headers.set('content-type', 'text/plain');
    expect((await POST(invalid)).status).toBe(415);
    const malformed = new Request(request(), { body: '{' });
    expect((await POST(malformed)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects oversized declared and streamed bodies, cancelling stream reads', async () => {
    const declared = request(); declared.headers.set('content-length', String(MAX_PAGE_REQUEST_BYTES + 1));
    expect((await POST(declared)).status).toBe(413);
    let cancelled = false;
    const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(MAX_PAGE_REQUEST_BYTES + 1)); }, cancel() { cancelled = true; } });
    const streamed = new Request(request(), { body: stream, duplex: 'half' } as RequestInit);
    expect((await POST(streamed)).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('returns a safe provider failure with no raw error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('secret-key private document'));
    const result = await POST(request());
    expect(result.status).toBe(502);
    expect(await result.text()).not.toMatch(/secret-key|private document/);
  });
  it('accepts ADMIN permission and returns no-store headers', async () => {
    session.mockResolvedValue({ user: { id: 'u1' }, orgId: 'o1', role: 'ADMIN' });
    const result = await POST(request());
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
  });
  it('cancels stalled incoming body reads when the browser disconnects', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; } });
    const incoming = new Request(request(), { body: stream, duplex: 'half', signal: controller.signal } as RequestInit);
    const result = POST(incoming);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect((await result).status).toBe(499);
    expect(cancelled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
