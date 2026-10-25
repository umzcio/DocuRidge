/**
 * Upload inspection: parse an uploaded PDF under the decode and seal-time work
 * ceilings and report its page count and seal cost, or why it is refused.
 *
 * Runs in the PDF worker (and inline under unit tests), so it must not import
 * the database, the env loader or anything that reads the filesystem.
 */

import { PDFDocument } from 'pdf-lib';
import { PdfDecodeLimitError, loadPdfWithDecodeLimits, withPdfDecodeBudget } from './decode-limits';
import { flattenPdfFormAppearances } from './form-appearance';
import { PdfComplexityError, assertSealCost, getPdfSealLimits, type PdfSealCost } from './seal-limits';
import { appendUprightPages } from './upright-page';

export type InspectRefusal = 'encrypted' | 'unreadable_pdf' | 'pdf_too_complex' | 'unsupported_form';

/** Why an `unreadable_pdf` refusal was made, when it has its own fixed text. */
export type InspectRefusalReason = 'no_pages';

export type InspectResult =
  | { ok: true; pageCount: number; sealCost: PdfSealCost }
  | { ok: false; code: InspectRefusal; message: string; reason?: InspectRefusalReason };

export const TOO_COMPLEX_MESSAGE =
  'This PDF is too large or complex for DocuRidge to process. Try re-saving or printing it to a new PDF and uploading again.';
export const UNREADABLE_MESSAGE =
  'PDF file looks corrupted or unreadable. Try re-saving from your PDF tool and uploading again.';
export const NO_PAGES_MESSAGE = 'PDF has no pages.';

/** The parent's fixed text for each refusal reason. */
const REASON_MESSAGES: Record<InspectRefusalReason, string> = {
  no_pages: NO_PAGES_MESSAGE,
};

const tooComplex = (): InspectResult => ({ ok: false, code: 'pdf_too_complex', message: TOO_COMPLEX_MESSAGE });
const unreadable = (reason?: InspectRefusalReason): InspectResult => ({
  ok: false,
  code: 'unreadable_pdf',
  message: reason ? REASON_MESSAGES[reason] : UNREADABLE_MESSAGE,
  ...(reason ? { reason } : {}),
});

/**
 * Run the seal's own page pipeline (seal-render.ts) on the flattened source,
 * into a throwaway document: copy every page upright, flush, and save, each
 * under its own decode budget as the seal does. pdf-lib throws on page
 * content it cannot copy (a /Resources entry, /Annots or /Contents of the
 * wrong type, inherited or not), and listing those shapes one by one never
 * ends; running the real code refuses exactly what sealing would throw on.
 */
async function preflightSealPages(doc: PDFDocument): Promise<void> {
  const scratch = await PDFDocument.create();
  await withPdfDecodeBudget(() => appendUprightPages(scratch, doc.getPages()));
  await withPdfDecodeBudget(() => scratch.flush());
  await withPdfDecodeBudget(() => scratch.save({ useObjectStreams: false }));
}

export async function inspectUploadedPdf(
  bytes: Uint8Array,
  opts: { ignoreEncryption?: boolean } = {},
): Promise<InspectResult> {
  try {
    let doc: PDFDocument;
    try {
      doc = await loadPdfWithDecodeLimits(bytes, {
        decodePageContents: true,
        ...(opts.ignoreEncryption ? { ignoreEncryption: true } : {}),
      });
    } catch (loadErr) {
      if (loadErr instanceof PdfDecodeLimitError || loadErr instanceof PdfComplexityError) return tooComplex();
      const m = loadErr instanceof Error ? loadErr.message : String(loadErr);
      if (!/encrypt|password|decrypt/i.test(m)) return unreadable();
      return { ok: false, code: 'encrypted', message: 'This PDF is encrypted.' };
    }
    const pageCount = doc.getPageCount();
    if (pageCount < 1) return unreadable('no_pages');
    // Sealing flattens the form before it embeds any page. Do the same flatten,
    // under the same caps, on this throwaway parse: a form that cannot be
    // sealed is refused now, not after the last signer has committed.
    try {
      await withPdfDecodeBudget(() => flattenPdfFormAppearances(doc));
    } catch (formErr) {
      if (formErr instanceof PdfComplexityError || formErr instanceof PdfDecodeLimitError) throw formErr;
      return {
        ok: false,
        code: 'unsupported_form',
        message:
          formErr instanceof Error && /flattened PDF/.test(formErr.message)
            ? formErr.message
            : 'This PDF form cannot be processed. Export a flattened PDF first.',
      };
    }
    // Then bound what sealing copies out of the flattened document.
    const sealCost = assertSealCost(doc);
    await preflightSealPages(doc);
    return { ok: true, pageCount, sealCost };
  } catch (err) {
    if (err instanceof PdfDecodeLimitError || err instanceof PdfComplexityError) return tooComplex();
    return unreadable();
  }
}

const FIXED_MESSAGES: Record<InspectRefusal, string> = {
  encrypted: 'This PDF is encrypted.',
  unreadable_pdf: UNREADABLE_MESSAGE,
  pdf_too_complex: TOO_COMPLEX_MESSAGE,
  unsupported_form: 'This PDF form cannot be processed. Export a flattened PDF first.',
};

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Validate a job output that crossed the process boundary. The worker parses
 * untrusted PDFs, so its answer is untrusted too: only the exact shapes are
 * accepted, the child's `message` is never used (the parent's fixed text is,
 * except a short `/flattened PDF/` form message), and a seal cost is re-checked
 * against the caps before it can be cached as the send-time measurement. An
 * `unreadable_pdf` refusal may name a known `reason` (e.g. `no_pages`), which
 * selects the parent's fixed text for it; an unknown reason is dropped and
 * the default text used. Any malformed answer is refused as too complex,
 * like a crashed worker.
 */
export function parseInspectResult(x: unknown): InspectResult {
  const bad = (): InspectResult => ({ ok: false, code: 'pdf_too_complex', message: TOO_COMPLEX_MESSAGE });
  if (typeof x !== 'object' || x === null) return bad();
  const v = x as Record<string, unknown>;
  if (v.ok === true) {
    const { pageCount, sealCost } = v;
    if (typeof pageCount !== 'number' || !Number.isSafeInteger(pageCount) || pageCount < 1) return bad();
    if (typeof sealCost !== 'object' || sealCost === null) return bad();
    const c = sealCost as Record<string, unknown>;
    if (!isCount(c.pages) || !isCount(c.objects) || !isCount(c.bytes)) return bad();
    if (c.pages !== pageCount) return bad();
    const limits = getPdfSealLimits();
    if (c.pages > limits.maxPages || c.objects > limits.maxSealObjects || c.bytes > limits.maxSealBytes) return bad();
    return { ok: true, pageCount, sealCost: { pages: c.pages, objects: c.objects, bytes: c.bytes } };
  }
  if (v.ok === false) {
    const code = v.code;
    if (code !== 'encrypted' && code !== 'unreadable_pdf' && code !== 'pdf_too_complex' && code !== 'unsupported_form') {
      return bad();
    }
    if (code === 'unreadable_pdf' && typeof v.reason === 'string' && Object.prototype.hasOwnProperty.call(REASON_MESSAGES, v.reason)) {
      const reason = v.reason as InspectRefusalReason;
      return { ok: false, code, message: REASON_MESSAGES[reason], reason };
    }
    let message = FIXED_MESSAGES[code];
    if (
      code === 'unsupported_form' &&
      typeof v.message === 'string' &&
      v.message.length <= 300 &&
      /flattened PDF/.test(v.message)
    ) {
      message = v.message;
    }
    return { ok: false, code, message };
  }
  return bad();
}
