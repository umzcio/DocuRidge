/**
 * Parent-side half of the canonicalize job: validate what the worker sent
 * back, and the fixed refusal text and upload code for each refusal.
 *
 * The worker parses untrusted PDFs, so its answer is untrusted too. This
 * module never parses a PDF: it imports only types from canonicalize.ts.
 */

import type { UploadValidationCode } from '../storage';
import type { CanonicalRefusalKey, CanonicalizeResult } from './canonicalize';
import { getPdfSealLimits } from './seal-limits';

export type { CanonicalRefusalKey, CanonicalizeResult } from './canonicalize';

/** Shown to the sender for each refusal; the child's own text never is (but see parseCanonicalizeResult). */
export const CANONICAL_REFUSAL_MESSAGES: Record<CanonicalRefusalKey, string> = {
  need_appearances:
    'This PDF form asks the viewer to redraw its fields, so it may not look the same when signed. Export a flattened PDF first.',
  visible_annotations:
    'This PDF has comments, markup or stamps that would not appear in the signed copy. Flatten them (for example, print to PDF) and upload again.',
  hidden_layers:
    'This PDF has hidden layers, so the signed copy could show content the signer never saw. Print it to a new PDF with the layers you want, and upload again.',
  self_check:
    'DocuRidge could not prepare this PDF for signing. Try re-saving or printing it to a new PDF and uploading again.',
  unsupported_form: 'This PDF form cannot be processed. Export a flattened PDF first.',
  no_pages: 'PDF has no pages.',
  unreadable_pdf: 'PDF file looks corrupted or unreadable. Try re-saving from your PDF tool and uploading again.',
  pdf_too_complex:
    'This PDF is too large or complex for DocuRidge to process. Try re-saving or printing it to a new PDF and uploading again.',
};

const UPLOAD_CODES: Record<CanonicalRefusalKey, UploadValidationCode> = {
  need_appearances: 'unsupported_form',
  visible_annotations: 'unsupported_content',
  hidden_layers: 'unsupported_content',
  self_check: 'unreadable_pdf',
  unsupported_form: 'unsupported_form',
  no_pages: 'unreadable_pdf',
  unreadable_pdf: 'unreadable_pdf',
  pdf_too_complex: 'pdf_too_complex',
};

/** The upload error code a refusal is reported under. */
export function canonicalRefusalUploadCode(key: CanonicalRefusalKey): UploadValidationCode {
  return UPLOAD_CODES[key];
}

function isRefusalKey(value: unknown): value is CanonicalRefusalKey | 'encrypted' {
  return value === 'encrypted' || (typeof value === 'string' && Object.prototype.hasOwnProperty.call(UPLOAD_CODES, value));
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/**
 * Validate a canonicalize job output that crossed the process boundary. An
 * ok result must carry `%PDF-` bytes within the seal byte cap, a page count
 * from 1 to the page cap, and a seal cost within the caps that counts the
 * same pages. A refusal keeps only a known key, plus, on `unsupported_form`
 * alone, a short message naming a "flattened PDF" (the flattener's own text,
 * as upload inspection passes it through today). Anything else is refused as
 * too complex, like a crashed worker.
 */
export function parseCanonicalizeResult(x: unknown): CanonicalizeResult {
  const bad = (): CanonicalizeResult => ({ ok: false, key: 'pdf_too_complex' });
  if (typeof x !== 'object' || x === null) return bad();
  const v = x as Record<string, unknown>;
  const limits = getPdfSealLimits();
  if (v.ok === true) {
    const { bytes, pageCount, sealCost } = v;
    if (!(bytes instanceof Uint8Array)) return bad();
    if (bytes.byteLength === 0 || bytes.byteLength > limits.maxSealBytes) return bad();
    if (!PDF_HEADER.every((byte, i) => bytes[i] === byte)) return bad();
    if (!isCount(pageCount) || pageCount < 1 || pageCount > limits.maxPages) return bad();
    if (typeof sealCost !== 'object' || sealCost === null) return bad();
    const c = sealCost as Record<string, unknown>;
    if (!isCount(c.pages) || !isCount(c.objects) || !isCount(c.bytes)) return bad();
    if (c.pages !== pageCount) return bad();
    if (c.objects > limits.maxSealObjects || c.bytes > limits.maxSealBytes) return bad();
    return { ok: true, bytes, pageCount, sealCost: { pages: c.pages, objects: c.objects, bytes: c.bytes } };
  }
  if (v.ok === false) {
    const key = v.key;
    if (!isRefusalKey(key)) return bad();
    if (
      key === 'unsupported_form' &&
      typeof v.message === 'string' &&
      v.message.length <= 300 &&
      /flattened PDF/.test(v.message)
    ) {
      return { ok: false, key, message: v.message };
    }
    return { ok: false, key };
  }
  return bad();
}
