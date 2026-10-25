/**
 * Hard ceilings on how much data pdf-lib may inflate from an untrusted PDF.
 *
 * pdf-lib 1.17 decodes FlateDecode/LZW/ASCII85/ASCIIHex/RunLength streams
 * synchronously into a buffer that doubles without bound, so a few hundred
 * bytes of nested `[/FlateDecode /FlateDecode]` can expand to gigabytes on the
 * event loop. It decodes object and cross-reference streams during
 * `PDFDocument.load()`, and page `/Contents` when a page is embedded
 * (canonicalization) or digested.
 *
 * Every pdf-lib decoder grows its output through `DecodeStream.ensureBuffer`,
 * so that one method is wrapped:
 *   - per stream: no single stream may decode past `maxStreamBytes`, always,
 *     even outside a budget scope;
 *   - per document: inside `withPdfDecodeBudget`, all streams decoded in that
 *     async context together may not exceed `maxTotalBytes`.
 * pdf-lib's parser swallows errors from individual objects, so a scope also
 * remembers the first limit hit and rethrows it when the work finishes.
 *
 * DecodeStream is not exported, so its prototype is found from a decoder
 * built through the public `decodePDFRawStream`; that resolves the same
 * pdf-lib instance as every other `import from 'pdf-lib'` in the bundle.
 *
 * Leaf module: reads its caps from `process.env` (see src/lib/env.ts for the
 * documented defaults) so it also works in scripts/verify.ts and in tests.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { PDFContext, PDFDict, PDFDocument, PDFName, PDFNumber, PDFArray, PDFRawStream, PDFRef, decodePDFRawStream, type PDFObject } from 'pdf-lib';
import { assertParseObjectCeiling, getParseObjectCeiling, withParseObjectCeiling } from './object-ceiling';
import { assertSourcePagesDrawable, pageTreeLeaves, type PageTreeMode } from './page-tree';
import { getPdfSealLimits } from './seal-limits';

/** Default ceiling on one decoded stream (64 MiB). */
export const DEFAULT_PDF_MAX_DECODED_STREAM_BYTES = 64 * 1024 * 1024;
/** Default ceiling on all streams decoded for one document operation (256 MiB). */
export const DEFAULT_PDF_MAX_DECODED_TOTAL_BYTES = 256 * 1024 * 1024;

export interface PdfDecodeLimits {
  maxStreamBytes: number;
  maxTotalBytes: number;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getPdfDecodeLimits(): PdfDecodeLimits {
  return {
    maxStreamBytes: positiveIntFromEnv('PDF_MAX_DECODED_STREAM_BYTES', DEFAULT_PDF_MAX_DECODED_STREAM_BYTES),
    maxTotalBytes: positiveIntFromEnv('PDF_MAX_DECODED_TOTAL_BYTES', DEFAULT_PDF_MAX_DECODED_TOTAL_BYTES),
  };
}

export class PdfDecodeLimitError extends Error {
  readonly code = 'pdf_decode_limit';
  constructor(
    readonly limit: 'stream' | 'total',
    readonly limitBytes: number,
  ) {
    super(
      limit === 'stream'
        ? `PDF stream decodes past the ${limitBytes}-byte per-stream limit`
        : `PDF streams decode past the ${limitBytes}-byte per-document limit`,
    );
    this.name = 'PdfDecodeLimitError';
  }
}

interface Budget {
  limits: PdfDecodeLimits;
  used: number;
  error?: PdfDecodeLimitError;
}

// Shared through globalThis: if a bundler instantiates this module twice
// against one pdf-lib, the single installed guard must still see every scope.
const BUDGETS = Symbol.for('docuridge.pdfDecodeBudgets');
const budgets: AsyncLocalStorage<Budget> = ((globalThis as Record<symbol, unknown>)[BUDGETS] ??=
  new AsyncLocalStorage<Budget>()) as AsyncLocalStorage<Budget>;
const COUNTED = Symbol('docuridge.decodedBytesCounted');
const GUARDED = Symbol.for('docuridge.pdfDecodeGuard');

type DecodeStreamLike = { [COUNTED]?: number };
type EnsureBuffer = (this: DecodeStreamLike, requested: number) => Uint8Array;

function installDecodeGuard(): void {
  const probe = decodePDFRawStream(PDFContext.create().flateStream(new Uint8Array(0)));
  let proto: Record<PropertyKey, unknown> | null = Object.getPrototypeOf(probe);
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'ensureBuffer')) {
    proto = Object.getPrototypeOf(proto);
  }
  if (!proto) {
    throw new Error('pdf-lib DecodeStream.ensureBuffer not found; PDF decode limits cannot be enforced');
  }
  if (proto[GUARDED]) return;
  const original = proto.ensureBuffer as EnsureBuffer;

  proto.ensureBuffer = function guardedEnsureBuffer(this: DecodeStreamLike, requested: number): Uint8Array {
    const budget = budgets.getStore();
    const limits = budget?.limits ?? getPdfDecodeLimits();
    const fail = (err: PdfDecodeLimitError): never => {
      if (budget && !budget.error) budget.error = err;
      throw err;
    };
    if (requested > limits.maxStreamBytes) fail(new PdfDecodeLimitError('stream', limits.maxStreamBytes));
    const counted = this[COUNTED] ?? 0;
    if (requested > counted) {
      if (budget) {
        budget.used += requested - counted;
        if (budget.used > limits.maxTotalBytes) fail(new PdfDecodeLimitError('total', limits.maxTotalBytes));
      }
      this[COUNTED] = requested;
    }
    return original.call(this, requested);
  };
  proto[GUARDED] = true;
}

installDecodeGuard();

/**
 * Run `fn` with a fresh per-document decode budget. Rejects with
 * `PdfDecodeLimitError` if any stream decoded inside it hit a limit, even
 * when pdf-lib caught that error and carried on.
 */
export async function withPdfDecodeBudget<T>(
  fn: () => Promise<T>,
  limits: PdfDecodeLimits = getPdfDecodeLimits(),
): Promise<T> {
  const budget: Budget = { limits, used: 0 };
  const result = await budgets.run(budget, fn);
  if (budget.error) throw budget.error;
  return result;
}

/** Filters whose /DecodeParms may carry a /Predictor. */
const PREDICTED_FILTERS = new Set(['FlateDecode', 'Fl', 'LZWDecode', 'LZW']);

/**
 * True when one of the stream's filters is Flate or LZW with a /Predictor
 * above 1. pdf-lib's decoder ignores /DecodeParms, so it would read such a
 * stream as the predicted bytes, not the content (pdf.js applies the
 * predictor). Each filter is paired with its own /DecodeParms entry.
 */
function usesPredictor(doc: PDFDocument, stream: PDFRawStream): boolean {
  const resolve = (value: PDFObject | undefined) => (value instanceof PDFRef ? doc.context.lookup(value) : value);
  const filter = resolve(stream.dict.get(PDFName.of('Filter')));
  const parms = resolve(stream.dict.get(PDFName.of('DecodeParms')));
  const filters = filter instanceof PDFArray ? filter.asArray().map(resolve) : [filter];
  const params = parms instanceof PDFArray ? parms.asArray().map(resolve) : [parms];
  return filters.some((name, i) => {
    if (!(name instanceof PDFName) || !PREDICTED_FILTERS.has(name.decodeText())) return false;
    const param = params[i];
    if (!(param instanceof PDFDict)) return false;
    const predictor = resolve(param.get(PDFName.of('Predictor')));
    return predictor instanceof PDFNumber && predictor.asNumber() > 1;
  });
}

/** A page content stream pdf-lib would decode wrongly (see `usesPredictor`). */
export class PdfPredictedContentError extends Error {
  constructor() {
    super('A page content stream uses a /Predictor');
    this.name = 'PdfPredictedContentError';
  }
}

/**
 * Decode every raw `/Contents` stream of every page (what embedding a page
 * does). A content stream with a /Predictor is refused first: embedding it
 * would draw a blank or garbled page without any error.
 */
function decodeAllPageContents(doc: PDFDocument, leaves: readonly PDFDict[]): void {
  for (const leaf of leaves) {
    const contents = leaf.get(PDFName.of('Contents'));
    const resolved = contents instanceof PDFRef ? doc.context.lookup(contents) : contents;
    const items = resolved instanceof PDFArray ? resolved.asArray() : [resolved];
    for (const item of items) {
      const stream = item instanceof PDFRef ? doc.context.lookup(item) : item;
      if (!(stream instanceof PDFRawStream)) continue;
      if (usesPredictor(doc, stream)) throw new PdfPredictedContentError();
      try {
        decodePDFRawStream(stream).decode();
      } catch (err) {
        // Unsupported or corrupt filters fail later exactly as they did
        // before; only the size limits are enforced here.
        if (err instanceof PdfDecodeLimitError) throw err;
      }
    }
  }
}

/**
 * `PDFDocument.load` under a decode budget. With `decodePageContents`, also
 * decodes every page's content streams inside the same budget, so a PDF that
 * would only detonate later (when a page is embedded into its canonical copy) is
 * rejected up front.
 *
 * The parse-object ceiling (`maxParseObjects`, default
 * `PDF_MAX_PARSE_OBJECTS`) is enforced twice: a byte scan of top-level
 * definitions before pdf-lib sees the file, then an exact count of every
 * object registered during the load itself, object-stream members included.
 *
 * The page tree is walked in `'source'` mode (page-tree.ts) unless
 * `pageTreeMode: 'sealed'` is passed: every source load (canonicalization,
 * at upload or for a legacy row) accepts the tree defects every reader reads
 * alike, and then requires every page to have the boxes canonicalization
 * lays it out by (`assertSourcePagesDrawable`), while files pdf-lib wrote
 * (sealed PDFs, canonical copies) are held to the strict walk.
 */
export async function loadPdfWithDecodeLimits(
  bytes: Uint8Array,
  options: Parameters<typeof PDFDocument.load>[1] & {
    decodePageContents?: boolean;
    maxPages?: number;
    maxParseObjects?: number;
    pageTreeMode?: PageTreeMode;
  } = {},
): Promise<PDFDocument> {
  const { decodePageContents, maxPages, maxParseObjects, pageTreeMode, ...loadOptions } = options;
  const maxObjects = maxParseObjects ?? getParseObjectCeiling();
  assertParseObjectCeiling(bytes, maxObjects);
  return withPdfDecodeBudget(async () => {
    const doc = await withParseObjectCeiling(() => PDFDocument.load(bytes, loadOptions), maxObjects);
    // Walk before anything calls doc.getPages(), which is exponential on a
    // page tree whose nodes are shared (both modes refuse sharing).
    const mode = pageTreeMode ?? 'source';
    const leaves = pageTreeLeaves(doc, { maxPages: maxPages ?? getPdfSealLimits().maxPages, mode });
    // A source page must also have the boxes canonicalization lays it out by.
    if (mode === 'source') assertSourcePagesDrawable(doc);
    if (decodePageContents) decodeAllPageContents(doc, leaves);
    return doc;
  });
}
