import { describe, expect, it, vi } from 'vitest';
import { fetchDocumentBytes } from './fetch-document';
import { CANONICAL_BUSY_MESSAGE, CANONICAL_UNAVAILABLE_MESSAGE, DOCUMENT_LOAD_FAILED_MESSAGE } from './messages';

const respond = (status: number, body = '', headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : body, { status, headers });

describe('fetchDocumentBytes', () => {
  it('returns the bytes of a 200', async () => {
    const fetchImpl = vi.fn(async () => respond(200, '%PDF-1.7'));
    const result = await fetchDocumentBytes('/doc', { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.ok && Buffer.from(result.bytes).toString()).toBe('%PDF-1.7');
  });

  it('shows the 409 body, the fixed "cannot be shown" text, not the status', async () => {
    const fetchImpl = vi.fn(async () => respond(409, CANONICAL_UNAVAILABLE_MESSAGE));
    expect(await fetchDocumentBytes('/doc', { fetchImpl })).toEqual({ ok: false, message: CANONICAL_UNAVAILABLE_MESSAGE });
  });

  it('falls back to the fixed text for a 409 body that is not the plain text', async () => {
    const fetchImpl = vi.fn(async () => respond(409, '<html>proxy error</html>'));
    expect(await fetchDocumentBytes('/doc', { fetchImpl })).toEqual({ ok: false, message: CANONICAL_UNAVAILABLE_MESSAGE });
  });

  it('waits out a 503 for its Retry-After seconds, then shows the document', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respond(503, CANONICAL_UNAVAILABLE_MESSAGE, { 'retry-after': '7' }))
      .mockResolvedValueOnce(respond(200, '%PDF-1.7'));
    const result = await fetchDocumentBytes('/doc', { fetchImpl, sleep });
    expect(result.ok).toBe(true);
    expect(sleep).toHaveBeenCalledWith(7000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after three tries on 503 with the fixed busy text, waiting at most 30 s each', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => respond(503, CANONICAL_UNAVAILABLE_MESSAGE, { 'retry-after': '3600' }));
    expect(await fetchDocumentBytes('/doc', { fetchImpl, sleep })).toEqual({ ok: false, message: CANONICAL_BUSY_MESSAGE });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[30_000], [30_000]]);
  });

  it.each([404, 500])('maps a %i to the fixed load-failed text', async (status) => {
    const fetchImpl = vi.fn(async () => respond(status, 'Internal details'));
    const result = await fetchDocumentBytes('/doc', { fetchImpl });
    expect(result).toEqual({ ok: false, message: DOCUMENT_LOAD_FAILED_MESSAGE });
    expect(JSON.stringify(result)).not.toContain(String(status));
  });

  it('maps a network failure to the fixed load-failed text', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await fetchDocumentBytes('/doc', { fetchImpl })).toEqual({ ok: false, message: DOCUMENT_LOAD_FAILED_MESSAGE });
  });
});
