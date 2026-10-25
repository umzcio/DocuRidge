/**
 * Fetch a document's bytes for a viewer in the browser, turning every failure
 * into text fit to show: a 409's own fixed body ("can't be shown right now"),
 * a 503 waited out per its Retry-After a few times and then a fixed "busy"
 * text, and anything else a fixed "couldn't be loaded" text. A bare status
 * code is never the message. Client-safe: no server imports.
 */
import {
  CANONICAL_BUSY_MESSAGE,
  CANONICAL_UNAVAILABLE_MESSAGE,
  DOCUMENT_LOAD_FAILED_MESSAGE,
} from './messages';

export type DocumentFetch = { ok: true; bytes: ArrayBuffer } | { ok: false; message: string };

export interface DocumentFetchOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts in all, the first included (default 3). */
  maxTries?: number;
  /** Ceiling on one wait, in seconds, whatever Retry-After says (default 30). */
  maxWaitSeconds?: number;
}

/** A 409 body is shown only when it reads as the server's own short plain text. */
function conflictMessage(body: string): string {
  const text = body.trim();
  return text && text.length <= 200 && !/[<>{}]/.test(text) ? text : CANONICAL_UNAVAILABLE_MESSAGE;
}

function retryAfterSeconds(res: Response, ceiling: number): number {
  const parsed = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, ceiling) : Math.min(5, ceiling);
}

export async function fetchDocumentBytes(url: string, options: DocumentFetchOptions = {}): Promise<DocumentFetch> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxTries = options.maxTries ?? 3;
  const ceiling = options.maxWaitSeconds ?? 30;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, { credentials: 'same-origin' });
    } catch {
      return { ok: false, message: DOCUMENT_LOAD_FAILED_MESSAGE };
    }
    if (res.ok) {
      try {
        return { ok: true, bytes: await res.arrayBuffer() };
      } catch {
        return { ok: false, message: DOCUMENT_LOAD_FAILED_MESSAGE };
      }
    }
    if (res.status === 409) {
      const body = await res.text().catch(() => '');
      return { ok: false, message: conflictMessage(body) };
    }
    if (res.status === 503) {
      if (attempt >= maxTries) return { ok: false, message: CANONICAL_BUSY_MESSAGE };
      await sleep(retryAfterSeconds(res, ceiling) * 1000);
      continue;
    }
    return { ok: false, message: DOCUMENT_LOAD_FAILED_MESSAGE };
  }
}
