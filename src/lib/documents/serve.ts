/**
 * Serving a pre-seal document: the canonical copy, never the upload. Shared by
 * every route that shows or hands out a document before it is sealed, so they
 * map the same failures to the same answers.
 */

import { CanonicalRefusedError, ensureCanonicalDocument } from '../pdf/canonical-source';
import { QpdfMissingError } from '../pdf/decrypt';
import { PdfWorkerError } from '../pdf-worker/runner';
import { CanonicalUnavailableError, readCanonicalPdf } from '../storage';

/** Fixed text for every "cannot be shown" answer; no exception message is ever echoed. */
export const CANONICAL_UNAVAILABLE_MESSAGE = "This document can't be shown right now. Contact the sender.";
export const CANONICAL_RETRY_AFTER_SECONDS = 30;

export type CanonicalServe =
  | { ok: true; bytes: Buffer; sha256: string }
  | { ok: false; status: 409 | 503 };

/**
 * The canonical bytes of a stored document, or the status to answer with:
 * 409 when this copy cannot be shown (refused, unreadable, changed on disk, a
 * worker crash or a deployment fault), 503 when the worker is busy or
 * unavailable and a retry may work. Other errors propagate. It never falls
 * back to the original bytes.
 */
export async function serveCanonicalDocument(documentFileId: string): Promise<CanonicalServe> {
  try {
    const canonical = await ensureCanonicalDocument(documentFileId);
    const bytes = await readCanonicalPdf(canonical);
    return { ok: true, bytes, sha256: canonical.sha256 };
  } catch (err) {
    if (err instanceof PdfWorkerError) {
      return { ok: false, status: err.reason === 'busy' || err.reason === 'unavailable' ? 503 : 409 };
    }
    if (
      err instanceof CanonicalRefusedError ||
      err instanceof CanonicalUnavailableError ||
      err instanceof QpdfMissingError
    ) {
      return { ok: false, status: 409 };
    }
    throw err;
  }
}

/** The plain-text response for a failed `serveCanonicalDocument`. */
export function canonicalFailureResponse(status: 409 | 503): Response {
  return new Response(CANONICAL_UNAVAILABLE_MESSAGE, {
    status,
    headers: status === 503 ? { 'retry-after': String(CANONICAL_RETRY_AFTER_SECONDS) } : undefined,
  });
}
