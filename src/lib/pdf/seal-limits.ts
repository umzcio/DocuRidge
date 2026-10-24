/**
 * Ceilings on the work sealing does for one source document, beyond the
 * decoded-byte caps in decode-limits.ts.
 *
 * Sealing runs inline in the last signer's request, so a document whose seal
 * cost is unbounded stalls or crashes the process that serves every org. The
 * same ceilings are applied when the PDF is uploaded (src/lib/storage.ts), so
 * anything accepted at upload can be sealed within them later.
 *
 * Leaf module: reads its caps from `process.env` (see src/lib/env.ts for the
 * documented defaults) so it also works in scripts, tests and the browser
 * bundle of the preparation editor, where `process` may be absent.
 */

/** Default ceiling on field dictionaries in the /AcroForm field tree. */
export const DEFAULT_PDF_MAX_FORM_FIELDS = 2000;
/** Default ceiling on widget annotations reachable from form fields. */
export const DEFAULT_PDF_MAX_FORM_WIDGETS = 2000;
/** Default ceiling on /Kids nesting and on a field's /Parent chain. */
export const DEFAULT_PDF_MAX_FORM_DEPTH = 32;
/** Default ceiling on /Annots entries summed over every page. */
export const DEFAULT_PDF_MAX_ANNOTATIONS = 20000;
/**
 * Default ceiling on text laid out to generate missing widget appearances,
 * summed over every widget (values, list options, comb cells, captions).
 */
export const DEFAULT_PDF_MAX_FORM_TEXT_CHARS = 4096;
/**
 * Default ceiling on the text of one multiline field whose appearance must be
 * generated. pdf-lib's multiline layout is roughly cubic in the text length
 * (about 50 ms at 256 characters, 2 s at 1,024, 18 s at 2,048).
 */
export const DEFAULT_PDF_MAX_FORM_MULTILINE_CHARS = 256;
/** Default ceiling on bytes of widget appearance content generated at flatten. */
export const DEFAULT_PDF_MAX_FORM_GENERATED_BYTES = 4 * 1024 * 1024;

export interface PdfSealLimits {
  maxFormFields: number;
  maxFormWidgets: number;
  maxFormDepth: number;
  maxAnnotations: number;
  maxFormTextChars: number;
  maxFormMultilineChars: number;
  maxFormGeneratedBytes: number;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = typeof process === 'undefined' ? undefined : process.env?.[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getPdfSealLimits(): PdfSealLimits {
  return {
    maxFormFields: positiveIntFromEnv('PDF_MAX_FORM_FIELDS', DEFAULT_PDF_MAX_FORM_FIELDS),
    maxFormWidgets: positiveIntFromEnv('PDF_MAX_FORM_WIDGETS', DEFAULT_PDF_MAX_FORM_WIDGETS),
    maxFormDepth: positiveIntFromEnv('PDF_MAX_FORM_DEPTH', DEFAULT_PDF_MAX_FORM_DEPTH),
    maxAnnotations: positiveIntFromEnv('PDF_MAX_ANNOTATIONS', DEFAULT_PDF_MAX_ANNOTATIONS),
    maxFormTextChars: positiveIntFromEnv('PDF_MAX_FORM_TEXT_CHARS', DEFAULT_PDF_MAX_FORM_TEXT_CHARS),
    maxFormMultilineChars: positiveIntFromEnv('PDF_MAX_FORM_MULTILINE_CHARS', DEFAULT_PDF_MAX_FORM_MULTILINE_CHARS),
    maxFormGeneratedBytes: positiveIntFromEnv('PDF_MAX_FORM_GENERATED_BYTES', DEFAULT_PDF_MAX_FORM_GENERATED_BYTES),
  };
}

export type PdfComplexityLimit =
  | 'form_fields'
  | 'form_widgets'
  | 'form_depth'
  | 'form_shape'
  | 'annotations'
  | 'form_text'
  | 'form_generated_bytes';

/** A PDF needs more seal-time work than the configured ceilings allow. */
export class PdfComplexityError extends Error {
  readonly code = 'pdf_too_complex';
  constructor(
    readonly limit: PdfComplexityLimit,
    message: string,
  ) {
    super(message);
    this.name = 'PdfComplexityError';
  }
}
