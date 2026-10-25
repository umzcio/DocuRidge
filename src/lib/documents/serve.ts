/**
 * Serving a pre-seal document: the canonical copy, never the upload. Shared by
 * every route that shows or hands out a document before it is sealed, and by
 * the signing submission, so they map the same failures to the same answers.
 */

import { CanonicalRefusedError, ensureCanonicalDocument } from '../pdf/canonical-source';
import { QpdfMissingError } from '../pdf/decrypt';
import { PdfWorkerError } from '../pdf-worker/runner';
import { childLogger } from '../logger';
import { CanonicalIntegrityError, CanonicalUnavailableError, readCanonicalPdf } from '../storage';
import { CANONICAL_BUSY_MESSAGE, CANONICAL_UNAVAILABLE_MESSAGE } from './messages';

export { CANONICAL_BUSY_MESSAGE, CANONICAL_UNAVAILABLE_MESSAGE };
export const CANONICAL_RETRY_AFTER_SECONDS = 30;

const log = childLogger({ module: 'documents-serve' });

export type CanonicalServe =
  | { ok: true; bytes: Buffer; sha256: string }
  | { ok: false; status: 409 | 503 };

/**
 * The answer for a failure to produce or read a canonical copy: 409 when this
 * copy cannot be shown (refused, unreadable, changed on disk, a worker crash,
 * timeout or out-of-memory, or a deployment fault), 503 when the worker is
 * busy or unavailable and a retry may work, or null for anything else (which
 * callers let propagate). A copy whose bytes no longer match its row is
 * logged, by document id only.
 */
export function canonicalFailureStatus(err: unknown, documentFileId: string): 409 | 503 | null {
  if (err instanceof PdfWorkerError) return err.reason === 'busy' || err.reason === 'unavailable' ? 503 : 409;
  if (err instanceof CanonicalIntegrityError) {
    log.error({ documentFileId }, 'canonical copy does not match its record');
    return 409;
  }
  if (err instanceof CanonicalRefusedError || err instanceof CanonicalUnavailableError || err instanceof QpdfMissingError) {
    return 409;
  }
  return null;
}

/**
 * The canonical bytes of a stored document, or the status to answer with
 * (`canonicalFailureStatus`). Other errors propagate. It never falls back to
 * the original bytes.
 */
export async function serveCanonicalDocument(documentFileId: string): Promise<CanonicalServe> {
  try {
    const canonical = await ensureCanonicalDocument(documentFileId);
    const bytes = await readCanonicalPdf(canonical);
    return { ok: true, bytes, sha256: canonical.sha256 };
  } catch (err) {
    const status = canonicalFailureStatus(err, documentFileId);
    if (status === null) throw err;
    return { ok: false, status };
  }
}

/**
 * Whether every document can be shown to a signer, checked before a signature
 * or approval is recorded: null when each has its canonical copy (made now if
 * missing), else the fixed text to answer with, the "cannot be shown" text or,
 * when the worker is busy, the "try again shortly" text. Other errors
 * propagate.
 */
export async function documentsUnavailableMessage(documentFileIds: readonly string[]): Promise<string | null> {
  for (const documentFileId of documentFileIds) {
    try {
      await ensureCanonicalDocument(documentFileId);
    } catch (err) {
      const status = canonicalFailureStatus(err, documentFileId);
      if (status === null) throw err;
      return status === 503 ? CANONICAL_BUSY_MESSAGE : CANONICAL_UNAVAILABLE_MESSAGE;
    }
  }
  return null;
}

/** The plain-text response for a failed `serveCanonicalDocument`. */
export function canonicalFailureResponse(status: 409 | 503): Response {
  return new Response(CANONICAL_UNAVAILABLE_MESSAGE, {
    status,
    headers: status === 503 ? { 'retry-after': String(CANONICAL_RETRY_AFTER_SECONDS) } : undefined,
  });
}
