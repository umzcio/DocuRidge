import { PdfDecodeLimitError } from '../pdf/decode-limits';
import { SealedContentStructureError } from '../pdf/page-tree';
import { PdfComplexityError, type PdfComplexityLimit } from '../pdf/seal-limits';
import type { SerializedError } from './protocol';

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

/**
 * Rebuild an error a job threw. The PDF limit errors come back as their own
 * classes with the same `limit`/`code`; anything else becomes a plain Error.
 */
export function reviveError(s: SerializedError): Error {
  let err: Error;
  if (s.name === 'PdfComplexityError' && typeof s.limit === 'string') {
    err = new PdfComplexityError(s.limit as PdfComplexityLimit, s.message);
  } else if (s.name === 'PdfDecodeLimitError' && (s.limit === 'stream' || s.limit === 'total')) {
    err = new PdfDecodeLimitError(s.limit, typeof s.limitBytes === 'number' ? s.limitBytes : 0);
  } else if (s.name === 'SealedContentStructureError') {
    err = new SealedContentStructureError(s.message);
  } else {
    err = new Error(s.message);
  }
  err.message = s.message;
  return err;
}
