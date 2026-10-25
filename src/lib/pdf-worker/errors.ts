import { PdfDecodeLimitError } from '../pdf/decode-limits';
import { SealedContentStructureError } from '../pdf/page-tree';
import { PdfComplexityError, type PdfComplexityLimit } from '../pdf/seal-limits';
import { isSerializedError, serializeError, type SerializedError } from './protocol';

export type PdfWorkerFailure = 'timeout' | 'out_of_memory' | 'crashed' | 'busy' | 'unavailable';

const MESSAGES: Record<PdfWorkerFailure, string> = {
  timeout: 'The PDF job ran past its time limit and was stopped',
  out_of_memory: 'The PDF job ran out of memory',
  crashed: 'The PDF worker exited before finishing the job',
  busy: 'Too many PDF jobs are running; the job waited too long for a worker',
  unavailable: 'The PDF worker is not installed',
};

/** The worker, not the job, failed: no result was produced. */
export class PdfWorkerError extends Error {
  constructor(
    readonly reason: PdfWorkerFailure,
    message: string = MESSAGES[reason],
  ) {
    super(message);
    this.name = 'PdfWorkerError';
  }
}

// Keyed by the union, so adding a PdfComplexityLimit without listing it here
// (or listing one that does not exist) fails to compile.
const COMPLEXITY_LIMITS: Record<PdfComplexityLimit, true> = {
  envelope_items: true,
  envelope_pages: true,
  envelope_seal_objects: true,
  envelope_seal_bytes: true,
  pages: true,
  parse_objects: true,
  seal_objects: true,
  seal_bytes: true,
  seal_image_pixels: true,
  form_fields: true,
  form_widgets: true,
  form_depth: true,
  form_shape: true,
  annotations: true,
  form_text: true,
  form_generated_bytes: true,
};

function isComplexityLimit(value: unknown): value is PdfComplexityLimit {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(COMPLEXITY_LIMITS, value);
}

/**
 * Rebuild an error a job threw. Total: it never throws, whatever the child
 * sent. The PDF limit errors come back as their own classes with the same
 * `limit`/`code` when the limit is a real one; anything else becomes a plain
 * Error, and a malformed value becomes `Error('PDF job failed')`.
 */
export function reviveError(value: unknown): Error {
  if (!isSerializedError(value)) return new Error('PDF job failed');
  const s: SerializedError = value;
  let err: Error;
  if (s.name === 'PdfComplexityError' && isComplexityLimit(s.limit)) {
    err = new PdfComplexityError(s.limit, s.message);
  } else if (s.name === 'PdfDecodeLimitError' && (s.limit === 'stream' || s.limit === 'total')) {
    const limitBytes = typeof s.limitBytes === 'number' && Number.isFinite(s.limitBytes) ? s.limitBytes : 0;
    err = new PdfDecodeLimitError(s.limit, limitBytes);
  } else if (s.name === 'SealedContentStructureError') {
    err = new SealedContentStructureError(s.message);
  } else {
    err = new Error(s.message);
  }
  err.message = s.message;
  return err;
}

/**
 * An `onRequest` failure as the child sees it. The PDF limit errors cross
 * intact; anything else crosses as a generic message, so parent internals
 * (DB errors, paths, key handling) never reach the process that parses
 * untrusted PDFs.
 */
export function serializeErrorForChild(err: unknown): SerializedError {
  if (
    err instanceof PdfComplexityError ||
    err instanceof PdfDecodeLimitError ||
    err instanceof SealedContentStructureError
  ) {
    return serializeError(err);
  }
  return { name: 'Error', message: 'The parent could not answer the PDF job request' };
}
