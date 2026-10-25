/**
 * Send-time check that every document of an envelope can be sealed.
 *
 * Upload (src/lib/storage.ts) refuses a PDF that sealing could not process
 * within the seal-limits.ts and decode-limits.ts caps, but an envelope can
 * also carry documents that never went through that check: items reused from
 * a template or a public form (they reference the template's DocumentFile),
 * and anything stored before the caps existed. Sealing runs after the last
 * signer has signed, so such a document must be refused when the envelope is
 * sent, before anyone signs, not discovered at completion.
 *
 * The measurement is the one upload does, run in the PDF worker: parse under the decode budget
 * (page contents included), flatten the form under the form caps, then
 * `assertSealCost`. Stored documents are content-addressed and never change,
 * so a result is cached per storage path and cap configuration; sending the
 * same template again does not re-parse its documents.
 */

import { UploadValidationError, inspectInWorker, readPdfFromStorage } from '../storage';
import { getPdfDecodeLimits } from './decode-limits';
import {
  PdfComplexityError,
  assertEnvelopeItemCount,
  assertEnvelopeSealCost,
  getPdfSealLimits,
  type PdfSealCost,
} from './seal-limits';

/** An envelope holds a document that sealing could not process. The message is safe to show. */
export class EnvelopeNotSealableError extends Error {
  readonly code = 'envelope_not_sealable';
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeNotSealableError';
  }
}

export interface SealCheckItem {
  title: string;
  documentFile: { storagePath: string };
}

const BUSY_MESSAGE = 'DocuRidge is busy processing other documents. Try sending again in a minute.';

type Measured = { ok: true; cost: PdfSealCost } | { ok: false; reason: 'too_complex' | 'unreadable'; detail?: string };

const CACHE_LIMIT = 512;
const cache = new Map<string, Measured>();

/** For tests. */
export function clearSealCostCache(): void {
  cache.clear();
}

async function measure(storagePath: string): Promise<Measured> {
  let bytes: Buffer;
  try {
    bytes = await readPdfFromStorage(storagePath);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  // The parse runs in the PDF worker. `ignoreEncryption` keeps the old
  // send-time behaviour for legacy files stored before upload decrypted them.
  let inspected;
  try {
    inspected = await inspectInWorker(bytes, { ignoreEncryption: true });
  } catch (err) {
    if (err instanceof UploadValidationError && err.code === 'busy') {
      throw new EnvelopeNotSealableError(BUSY_MESSAGE);
    }
    throw err;
  }
  if (inspected.ok) return { ok: true, cost: inspected.sealCost };
  if (inspected.code === 'pdf_too_complex') return { ok: false, reason: 'too_complex', detail: inspected.message };
  return { ok: false, reason: 'unreadable' };
}

/** Measure one stored document's seal cost, cached per path and cap configuration. */
async function storedDocumentSealCost(storagePath: string): Promise<Measured> {
  const key = JSON.stringify([storagePath, getPdfSealLimits(), getPdfDecodeLimits()]);
  const hit = cache.get(key);
  if (hit) return hit;
  const measured = await measure(storagePath);
  // A read failure may be transient (storage briefly unavailable): not cached.
  if (measured.ok || measured.reason === 'too_complex') {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(key, measured);
  }
  return measured;
}

/** Remember a cost measured at upload, the same measurement, so send skips the re-parse. */
export function rememberSealCost(storagePath: string, cost: PdfSealCost): void {
  const key = JSON.stringify([storagePath, getPdfSealLimits(), getPdfDecodeLimits()]);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, { ok: true, cost });
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
    const measured = await storedDocumentSealCost(item.documentFile.storagePath);
    if (!measured.ok) {
      throw new EnvelopeNotSealableError(
        measured.reason === 'too_complex'
          ? `"${item.title}" is too large or complex to seal (${measured.detail}). Replace it with a re-saved or printed-to-PDF copy before sending.`
          : `"${item.title}" could not be read, so it could not be sealed. Replace it before sending.`,
      );
    }
    costs.push(measured.cost);
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
