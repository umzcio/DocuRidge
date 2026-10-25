/**
 * Send-time check that every document of an envelope can be sealed.
 *
 * Upload (src/lib/storage.ts) canonicalizes every PDF and stores its seal
 * cost on the DocumentFile row, refusing one that sealing could not process.
 * An envelope can also carry documents that never went through that check:
 * items reused from a template or a public form (they reference the
 * template's DocumentFile), and anything stored before canonical copies
 * existed. Sealing runs after the last signer has signed, so such a document
 * must be refused when the envelope is sent, before anyone signs, not
 * discovered at completion.
 *
 * The cost is read from the row (canonical-source.ts), which canonicalizes a
 * legacy row once and stores the result; sending the same template again
 * runs no job.
 */

import { CanonicalUnavailableError } from '../storage';
import { PdfWorkerError } from '../pdf-worker/runner';
import { CanonicalRefusedError, ensureCanonicalDocument } from './canonical-source';
import { QpdfMissingError } from './decrypt';
import {
  PdfComplexityError,
  assertEnvelopeItemCount,
  assertEnvelopeSealCost,
  type PdfSealCost,
} from './seal-limits';

/**
 * An envelope holds a document that sealing could not process. The message is
 * safe to show. `retryable` is true when nothing is wrong with the envelope
 * and the same request may succeed later (the PDF worker was busy or could
 * not start); callers answer that as "try again", not as a bad request.
 */
export class EnvelopeNotSealableError extends Error {
  readonly code = 'envelope_not_sealable';
  readonly retryable: boolean;
  constructor(message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'EnvelopeNotSealableError';
    this.retryable = options.retryable ?? false;
  }
}

export interface SealCheckItem {
  title: string;
  documentFileId: string;
}

const BUSY_MESSAGE = 'DocuRidge is busy processing other documents. Try sending again in a minute.';

/** One item's seal cost, or the EnvelopeNotSealableError that names the document. */
async function itemSealCost(item: SealCheckItem): Promise<PdfSealCost> {
  const unreadable = () =>
    new EnvelopeNotSealableError(`"${item.title}" could not be read, so it could not be sealed. Replace it before sending.`);
  try {
    return (await ensureCanonicalDocument(item.documentFileId)).sealCost;
  } catch (err) {
    if (err instanceof CanonicalRefusedError) {
      throw new EnvelopeNotSealableError(`"${item.title}" can't be sent: ${err.message}`);
    }
    if (err instanceof PdfWorkerError) {
      if (err.reason === 'busy' || err.reason === 'unavailable') {
        throw new EnvelopeNotSealableError(BUSY_MESSAGE, { retryable: true });
      }
      // A crash may be transient, but nothing was stored: unreadable now, tried again on the next send.
      throw unreadable();
    }
    // A deployment fault (no qpdf) or a missing row or file: the child's or the system's text is never shown.
    if (err instanceof CanonicalUnavailableError || err instanceof QpdfMissingError) throw unreadable();
    throw err;
  }
}

/**
 * Throw `EnvelopeNotSealableError` unless the envelope's documents can be
 * sealed: each within the per-document caps (the error names the document),
 * and all of them within the envelope-wide caps on the number of documents
 * and on their summed cost. `extra` is the cost of a document about to be
 * added that is not in `items` yet. Returns each item's cost, in order.
 */
export async function assertEnvelopeItemsSealable(
  items: readonly SealCheckItem[],
  extra: readonly PdfSealCost[] = [],
): Promise<PdfSealCost[]> {
  envelopeCheck(() => assertEnvelopeItemCount(items.length + extra.length));
  const costs: PdfSealCost[] = [];
  for (const item of items) {
    costs.push(await itemSealCost(item));
  }
  envelopeCheck(() => assertEnvelopeSealCost([...costs, ...extra]));
  return costs;
}

function envelopeCheck(check: () => unknown): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof PdfComplexityError)) throw err;
    throw new EnvelopeNotSealableError(
      err.limit === 'envelope_items'
        ? `${err.message}. Split the documents across several envelopes.`
        : `This envelope is too large to seal: ${err.message}. Remove documents or split them across several envelopes.`,
    );
  }
}
