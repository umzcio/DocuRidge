import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { getAiConfiguration, suggestPageFields, AiSuggestionError, MAX_PROVIDER_RESPONSE_BYTES, PROVIDER_TIMEOUT_MS } from './provider';

const page = { image: 'data:image/jpeg;base64,/9j/2Q==', text: 'Signature [x=0.1,y=0.5]', page: 2 };
const field = { type: 'SIGNATURE', page: 2, x: 0.1, y: 0.5, w: 0.3, h: 0.06, label: 'Signature', confidence: 0.9 };
const response = (suggestions: unknown = [field]) => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ suggestions }) } }] });

describe('vision provider', () => {
  beforeEach(() => {
    vi.stubEnv('DOCURIDGE_AI_BASE_URL', 'https://provider.example/v1/');
    vi.stubEnv('DOCURIDGE_AI_MODEL', 'vision-test');
    vi.stubEnv('DOCURIDGE_AI_API_KEY', 'secret-key');
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('requires a configured root/model, permits local HTTP without a key, and rejects unsafe config', () => {
    vi.stubEnv('DOCURIDGE_AI_MODEL', '');
    expect(getAiConfiguration()).toBeNull();
    vi.stubEnv('DOCURIDGE_AI_MODEL', 'local');
    vi.stubEnv('DOCURIDGE_AI_BASE_URL', 'http://localhost:1234/v1');
    vi.stubEnv('DOCURIDGE_AI_API_KEY', '');
    expect(getAiConfiguration()).toEqual({ baseUrl: 'http://localhost:1234/v1', model: 'local', apiKey: '' });
    for (const url of ['file:///etc/passwd', 'https://user:pass@host/v1', 'https://host/v1?key=secret']) {
      vi.stubEnv('DOCURIDGE_AI_BASE_URL', url);
      expect(getAiConfiguration()).toBeNull();
    }
  });
  it('sends the page to the configured API and returns validated deduplicated suggestions', async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      expect(url).toBe('https://provider.example/v1/chat/completions');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-key');
      expect(init?.redirect).toBe('error');
      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe('vision-test');
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.messages[0].content).toContain('untrusted');
      expect(body.messages[0].content).toContain('y + h <= L');
      expect(body.messages[0].content).toContain('text baselines');
      expect(body.messages[1].content[1].image_url.url).toBe(page.image);
      return response([field, { ...field, x: 0.101 }]);
    });
    expect(await suggestPageFields(page)).toEqual([field]);
  });
  it.each([() => new Response('SECRET provider error', { status: 401 }), () => new Response('not json'), () => response([{ ...field, page: 7 }]), () => response([{ ...field, x: 3 }]), () => response(Array(81).fill(field)), () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{"suggestions":[]}' } }] })])('rejects provider errors without exposing raw content', async (makeResponse) => {
    vi.mocked(fetch).mockResolvedValue(makeResponse());
    await expect(suggestPageFields(page)).rejects.toMatchObject({ name: 'AiSuggestionError', status: 502 });
    await suggestPageFields(page).catch((error) => expect(error.message).not.toContain('SECRET'));
  });
  it('bounds streamed provider bytes even without a content-length header', async () => {
    let cancelled = false;
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES + 1)); }, cancel() { cancelled = true; } })));
    await expect(suggestPageFields(page)).rejects.toBeInstanceOf(AiSuggestionError);
    expect(cancelled).toBe(true);
  });
  it('times out and aborts the outgoing request', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      signal = init?.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const result = expect(suggestPageFields(page)).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS + 1);
    await result;
    expect(signal?.aborted).toBe(true);
  });
  it('propagates browser cancellation', async () => {
    const controller = new AbortController();
    vi.mocked(fetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const result = expect(suggestPageFields(page, controller.signal)).rejects.toMatchObject({ status: 499 });
    controller.abort();
    await result;
  });
  it('times out a provider that sends headers but stalls its response body', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    const result = expect(suggestPageFields(page)).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS + 1);
    await result;
    expect(cancelled).toBe(true);
  });
  it('does not start a request when already cancelled or disabled', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(suggestPageFields(page, controller.signal)).rejects.toMatchObject({ status: 499 });
    vi.stubEnv('DOCURIDGE_AI_BASE_URL', '');
    await expect(suggestPageFields(page)).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
