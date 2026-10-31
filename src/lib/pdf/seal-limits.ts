/**
 * Ceilings on the work sealing does for one source document, beyond the
 * decoded-byte caps in decode-limits.ts.
 *
 * Sealing runs inline in the last signer's request, so a document whose seal
 * cost is unbounded stalls or crashes the process that serves every org. The
 * same ceilings are applied when the PDF is uploaded (src/lib/storage.ts), so
 * anything accepted at upload can be sealed within them later.
 *
 * Leaf module (pdf-lib only): reads its caps from `process.env` (see src/lib/env.ts for the
 * documented defaults) so it also works in scripts, tests and the browser
 * bundle of the preparation editor, where `process` may be absent.
 */

import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, type PDFDocument, type PDFObject, type PDFPageLeaf } from 'pdf-lib';

/** Default ceiling on pages in one document. */
export const DEFAULT_PDF_MAX_PAGES = 2000;
/**
 * Default ceiling on PDF objects sealing copies from one document, counting
 * every dictionary entry and array element reachable from its pages.
 */
export const DEFAULT_PDF_MAX_SEAL_OBJECTS = 1_000_000;
/**
 * Default ceiling on stream bytes sealing writes for one document: each
 * distinct stream reachable from its pages once, plus each page's content
 * again (sealing re-encodes it into that page's Form XObject).
 */
export const DEFAULT_PDF_MAX_SEAL_BYTES = 128 * 1024 * 1024;
/** Default ceiling on field dictionaries in the /AcroForm field tree. */
export const DEFAULT_PDF_MAX_FORM_FIELDS = 2000;
/** Default ceiling on widget annotations reachable from form fields. */
export const DEFAULT_PDF_MAX_FORM_WIDGETS = 2000;
/** Default ceiling on /Kids nesting and on a field's /Parent chain. */
export const DEFAULT_PDF_MAX_FORM_DEPTH = 32;
/** Default ceiling on /Annots entries summed over every page. */
export const DEFAULT_PDF_MAX_ANNOTATIONS = 20000;

/*
 * Envelope-wide ceilings. The caps above bound one document, but one seal
 * copies every document of the envelope into one output and saves it, and
 * the per-document caps alone would let 25 documents demand 25 times the
 * memory. These bound the sum of the per-document costs (`assertSealCost`).
 */
/** Default ceiling on documents in one envelope. */
export const DEFAULT_PDF_MAX_ENVELOPE_ITEMS = 25;
/** Default ceiling on pages summed over an envelope's documents. */
export const DEFAULT_PDF_MAX_ENVELOPE_PAGES = 4000;
/** Default ceiling on seal objects summed over an envelope's documents. */
export const DEFAULT_PDF_MAX_ENVELOPE_SEAL_OBJECTS = 2_000_000;
/** Default ceiling on seal stream bytes summed over an envelope's documents. */
export const DEFAULT_PDF_MAX_ENVELOPE_SEAL_BYTES = 256 * 1024 * 1024;

export interface PdfSealLimits {
  maxPages: number;
  maxSealObjects: number;
  maxSealBytes: number;
  maxFormFields: number;
  maxFormWidgets: number;
  maxFormDepth: number;
  maxAnnotations: number;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = typeof process === 'undefined' ? undefined : process.env?.[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getPdfSealLimits(): PdfSealLimits {
  return {
    maxPages: positiveIntFromEnv('PDF_MAX_PAGES', DEFAULT_PDF_MAX_PAGES),
    maxSealObjects: positiveIntFromEnv('PDF_MAX_SEAL_OBJECTS', DEFAULT_PDF_MAX_SEAL_OBJECTS),
    maxSealBytes: positiveIntFromEnv('PDF_MAX_SEAL_BYTES', DEFAULT_PDF_MAX_SEAL_BYTES),
    maxFormFields: positiveIntFromEnv('PDF_MAX_FORM_FIELDS', DEFAULT_PDF_MAX_FORM_FIELDS),
    maxFormWidgets: positiveIntFromEnv('PDF_MAX_FORM_WIDGETS', DEFAULT_PDF_MAX_FORM_WIDGETS),
    maxFormDepth: positiveIntFromEnv('PDF_MAX_FORM_DEPTH', DEFAULT_PDF_MAX_FORM_DEPTH),
    maxAnnotations: positiveIntFromEnv('PDF_MAX_ANNOTATIONS', DEFAULT_PDF_MAX_ANNOTATIONS),
  };
}

export interface EnvelopeSealLimits {
  maxItems: number;
  maxPages: number;
  maxSealObjects: number;
  maxSealBytes: number;
}

export function getEnvelopeSealLimits(): EnvelopeSealLimits {
  return {
    maxItems: positiveIntFromEnv('PDF_MAX_ENVELOPE_ITEMS', DEFAULT_PDF_MAX_ENVELOPE_ITEMS),
    maxPages: positiveIntFromEnv('PDF_MAX_ENVELOPE_PAGES', DEFAULT_PDF_MAX_ENVELOPE_PAGES),
    maxSealObjects: positiveIntFromEnv('PDF_MAX_ENVELOPE_SEAL_OBJECTS', DEFAULT_PDF_MAX_ENVELOPE_SEAL_OBJECTS),
    maxSealBytes: positiveIntFromEnv('PDF_MAX_ENVELOPE_SEAL_BYTES', DEFAULT_PDF_MAX_ENVELOPE_SEAL_BYTES),
  };
}

export type PdfComplexityLimit =
  | 'envelope_items'
  | 'envelope_pages'
  | 'envelope_seal_objects'
  | 'envelope_seal_bytes'
  | 'pages'
  | 'parse_objects'
  | 'seal_objects'
  | 'seal_bytes'
  | 'seal_image_pixels'
  | 'seal_image_bytes'
  | 'form_fields'
  | 'form_widgets'
  | 'form_depth'
  | 'form_shape'
  | 'annotations';

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

export interface PdfSealCost {
  pages: number;
  /** Dictionary entries and array elements reachable from the pages. */
  objects: number;
  /** Encoded stream bytes sealing writes (see DEFAULT_PDF_MAX_SEAL_BYTES). */
  bytes: number;
}

/** Refuse an envelope with more documents than `limits.maxItems`. */
export function assertEnvelopeItemCount(count: number, limits: EnvelopeSealLimits = getEnvelopeSealLimits()): void {
  if (count > limits.maxItems) {
    throw new PdfComplexityError('envelope_items', `The envelope has more than ${limits.maxItems} documents`);
  }
}

/**
 * Refuse an envelope whose documents' seal costs (from `assertSealCost`)
 * together pass the envelope-wide caps; returns the totals. Upload, send
 * and sealing all check the same sums, so an envelope accepted at send can
 * be sealed.
 */
export function assertEnvelopeSealCost(
  costs: readonly PdfSealCost[],
  limits: EnvelopeSealLimits = getEnvelopeSealLimits(),
): PdfSealCost {
  assertEnvelopeItemCount(costs.length, limits);
  const total: PdfSealCost = { pages: 0, objects: 0, bytes: 0 };
  for (const cost of costs) {
    total.pages += cost.pages;
    total.objects += cost.objects;
    total.bytes += cost.bytes;
  }
  if (total.pages > limits.maxPages) {
    throw new PdfComplexityError('envelope_pages', `The envelope's documents have more than ${limits.maxPages} pages in total`);
  }
  if (total.objects > limits.maxSealObjects) {
    throw new PdfComplexityError(
      'envelope_seal_objects',
      `The envelope's documents together reach more than ${limits.maxSealObjects} objects`,
    );
  }
  if (total.bytes > limits.maxSealBytes) {
    throw new PdfComplexityError(
      'envelope_seal_bytes',
      `The envelope's documents together reach more than ${limits.maxSealBytes} bytes of stream data`,
    );
  }
  return total;
}

const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'].map((key) => PDFName.of(key));

function streamBytes(stream: PDFStream): number {
  return stream.getContentsSize();
}

/** Encoded size of a page's /Contents, which sealing decodes into a new stream per page. */
function contentBytes(page: PDFPageLeaf): number {
  const contents = page.Contents();
  if (contents instanceof PDFStream) return streamBytes(contents);
  let bytes = 0;
  if (contents instanceof PDFArray) {
    for (let i = 0, n = contents.size(); i < n; i++) {
      const item = contents.lookup(i);
      if (item instanceof PDFStream) bytes += streamBytes(item);
    }
  }
  return bytes;
}

/**
 * Measure what sealing copies out of `doc` and refuse it over the caps.
 *
 * Canonicalization embeds every page of a document, and sealing copies every
 * page of its canonical copy, through one pdf-lib object copier, which
 * copies each page dictionary (minus its /Parent, plus inherited entries)
 * and everything reachable from it, once per object. This walks the same
 * graph with the same memo, so the count is what will be copied, and stops
 * as soon as a cap is passed. Run it after flattening, as canonicalization
 * does.
 */
export function assertSealCost(doc: PDFDocument, limits: PdfSealLimits = getPdfSealLimits()): PdfSealCost {
  const pages = doc.getPages();
  if (pages.length > limits.maxPages) {
    throw new PdfComplexityError('pages', `PDF has more than ${limits.maxPages} pages`);
  }
  const cost: PdfSealCost = { pages: pages.length, objects: 0, bytes: 0 };
  const addObjects = (n: number) => {
    cost.objects += n;
    if (cost.objects > limits.maxSealObjects) {
      throw new PdfComplexityError('seal_objects', `PDF pages reach more than ${limits.maxSealObjects} objects`);
    }
  };
  const addBytes = (n: number) => {
    cost.bytes += n;
    if (cost.bytes > limits.maxSealBytes) {
      throw new PdfComplexityError('seal_bytes', `PDF pages reach more than ${limits.maxSealBytes} bytes of stream data`);
    }
  };

  const seen = new Set<PDFObject>();
  const pending: PDFObject[] = [];
  const drain = () => {
    while (pending.length) {
      let object: PDFObject | undefined = pending.pop()!;
      if (object instanceof PDFRef) {
        if (seen.has(object)) continue;
        seen.add(object);
        object = doc.context.lookup(object);
      }
      if (!(object instanceof PDFDict || object instanceof PDFArray || object instanceof PDFStream)) continue;
      if (seen.has(object)) continue;
      seen.add(object);
      if (object instanceof PDFArray) {
        addObjects(object.size());
        for (let i = 0, n = object.size(); i < n; i++) pending.push(object.get(i));
        continue;
      }
      const dict = object instanceof PDFStream ? object.dict : object;
      if (object instanceof PDFStream) addBytes(streamBytes(object));
      const entries = dict.entries();
      addObjects(entries.length + 1);
      for (const [, value] of entries) pending.push(value);
    }
  };

  for (const page of pages) {
    addBytes(contentBytes(page.node));
    const entries = page.node.entries();
    addObjects(entries.length + 1);
    for (const [key, value] of entries) if (key !== PDFName.Parent) pending.push(value);
    for (const key of INHERITABLE) {
      if (page.node.has(key)) continue;
      const inherited = page.node.getInheritableAttribute(key);
      if (inherited) pending.push(inherited);
    }
    drain();
  }
  return cost;
}
