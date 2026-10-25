/**
 * Upload inspection: parse an uploaded PDF under the decode and seal-time work
 * ceilings and report its page count and seal cost, or why it is refused.
 *
 * Runs in the PDF worker (and inline under unit tests), so it must not import
 * the database, the env loader or anything that reads the filesystem.
 */

import { PdfDecodeLimitError, loadPdfWithDecodeLimits, withPdfDecodeBudget } from './decode-limits';
import { flattenPdfFormAppearances } from './form-appearance';
import { PdfComplexityError, assertSealCost, getPdfSealLimits, type PdfSealCost } from './seal-limits';

export type InspectRefusal = 'encrypted' | 'unreadable_pdf' | 'pdf_too_complex' | 'unsupported_form';

export type InspectResult =
  | { ok: true; pageCount: number; sealCost: PdfSealCost }
  | { ok: false; code: InspectRefusal; message: string };

export const TOO_COMPLEX_MESSAGE =
  'This PDF is too large or complex for DocuRidge to process. Try re-saving or printing it to a new PDF and uploading again.';
export const UNREADABLE_MESSAGE =
  'PDF file looks corrupted or unreadable. Try re-saving from your PDF tool and uploading again.';

const tooComplex = (): InspectResult => ({ ok: false, code: 'pdf_too_complex', message: TOO_COMPLEX_MESSAGE });
const unreadable = (message: string = UNREADABLE_MESSAGE): InspectResult => ({
  ok: false,
  code: 'unreadable_pdf',
  message,
});

export async function inspectUploadedPdf(
  bytes: Uint8Array,
  opts: { ignoreEncryption?: boolean } = {},
): Promise<InspectResult> {
  try {
    let doc: import('pdf-lib').PDFDocument;
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
    if (pageCount < 1) return unreadable('PDF has no pages.');
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
    return { ok: true, pageCount, sealCost: assertSealCost(doc) };
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
 * against the caps before it can be cached as the send-time measurement. Any
 * malformed answer is refused as too complex, like a crashed worker.
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
