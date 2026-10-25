/**
 * Canonicalization: rewrite an uploaded PDF, once, into the seal's own page
 * layout minus the stamps. Signers are shown this file and the seal starts
 * from it, so what a signer sees is what gets sealed.
 *
 * The canonical file is the flattened source drawn upright onto fresh pages
 * by `appendUprightPages`, exactly as sealing lays it out today, in a new
 * document: no annotations, no form, no catalog extras (outlines, names,
 * structure tree, metadata, optional-content properties), an Info dictionary
 * holding only /Producer, and no object the trailer does not reach. Same
 * input, same bytes.
 *
 * Runs in the PDF worker (and inline under unit tests), so it must not import
 * the database, the env loader, keys, the audit log or the logger, and must
 * not read files.
 */

import { PDFDocument } from 'pdf-lib';
import { checkPdfStructure } from '../verify/pdf-structure';
import { PdfDecodeLimitError, loadPdfWithDecodeLimits, withPdfDecodeBudget } from './decode-limits';
import { flattenPdfFormAppearances } from './form-appearance';
import { pageTreeLeaves, sealedMaxParseObjects } from './page-tree';
import { PdfComplexityError, assertSealCost, getPdfSealLimits, type PdfSealCost } from './seal-limits';
import { SourcePolicyError, assertNoNeedAppearances, assertNoVisibleAnnotations, optionalContentPolicy } from './source-policy';
import { appendUprightPages } from './upright-page';

export type CanonicalRefusalKey =
  | 'need_appearances'
  | 'visible_annotations'
  | 'hidden_layers'
  | 'self_check'
  | 'unsupported_form'
  | 'no_pages'
  | 'unreadable_pdf'
  | 'pdf_too_complex';

export type CanonicalizeResult =
  | { ok: true; bytes: Uint8Array; pageCount: number; sealCost: PdfSealCost }
  /** `message` only on `unsupported_form`: the flattener's own "flattened PDF" text. */
  | { ok: false; key: CanonicalRefusalKey | 'encrypted'; message?: string };

/** Stops the pipeline with a refusal. */
class Refusal extends Error {
  constructor(readonly result: Extract<CanonicalizeResult, { ok: false }>) {
    super(result.key);
    this.name = 'CanonicalizeRefusal';
  }
}

const refuse = (key: CanonicalRefusalKey | 'encrypted', message?: string): never => {
  throw new Refusal({ ok: false, key, ...(message !== undefined ? { message } : {}) });
};

const isLimitError = (err: unknown) => err instanceof PdfDecodeLimitError || err instanceof PdfComplexityError;

/** Fixed seed for the job's `Math.random`; any constant will do. */
const RANDOM_SEED = 0x2f6b_d1a3;

/** mulberry32: a small deterministic generator with Math.random's range [0, 1). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Run `fn` with `Math.random` replaced by a fixed-seed generator, and restore
 * it afterwards, on success or failure. This is a backstop, not what makes
 * the output deterministic: the names pdf-lib 1.17.1 gives the resources it
 * adds (the flattened widgets' XObjects, an embedded font, the embedded
 * pages) come from each document's own fixed-seed generator, not
 * `Math.random`. The override covers any `Math.random` use on the path, in
 * pdf-lib or anything it calls, now or after an upgrade. The worker child
 * runs one job per process; inline (unit tests), nothing else runs alongside.
 */
async function withSeededRandom<T>(fn: () => Promise<T>): Promise<T> {
  const original = Math.random;
  Math.random = seededRandom(RANDOM_SEED);
  try {
    return await fn();
  } finally {
    Math.random = original;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
    Buffer.from(b.buffer, b.byteOffset, b.byteLength),
  );
}

/** Step 1: parse under the decode and parse-object ceilings, walking the page tree in source mode. */
async function loadSource(bytes: Uint8Array, ignoreEncryption: boolean): Promise<PDFDocument> {
  try {
    return await loadPdfWithDecodeLimits(bytes, {
      decodePageContents: true,
      ...(ignoreEncryption ? { ignoreEncryption: true } : {}),
    });
  } catch (err) {
    if (isLimitError(err)) return refuse('pdf_too_complex');
    const message = err instanceof Error ? err.message : String(err);
    return refuse(/encrypt|password|decrypt/i.test(message) ? 'encrypted' : 'unreadable_pdf');
  }
}

/** Step 4: bake the form's widget appearances into the page content, as sealing does. */
async function flattenForm(source: PDFDocument): Promise<void> {
  try {
    await withPdfDecodeBudget(() => flattenPdfFormAppearances(source));
  } catch (err) {
    if (isLimitError(err)) throw err;
    const message = err instanceof Error && /flattened PDF/.test(err.message) ? err.message : undefined;
    refuse('unsupported_form', message);
  }
}

/**
 * Steps 6 to 8: draw every page upright into a fresh document and write it.
 *
 * `appendUprightPages` (through pdf-lib's `embedPages`) copies each whole
 * source page dictionary into the document it draws into, so that document
 * also holds objects nothing references: the original /Contents streams and
 * whatever /Annots still listed (Link dictionaries and their URIs, hidden
 * annotations). Signers are served this file and every indirect object in it
 * must be reachable, so the drawn pages are copied once more, into the
 * document that is written; a copy takes only what the pages reach.
 */
async function writeCanonical(source: PDFDocument): Promise<Uint8Array> {
  const drawn = await PDFDocument.create({ updateMetadata: false });
  await withPdfDecodeBudget(() => appendUprightPages(drawn, source.getPages()));
  await withPdfDecodeBudget(() => drawn.flush());
  const out = await PDFDocument.create({ updateMetadata: false });
  out.setProducer('DocuRidge');
  for (const page of await out.copyPages(drawn, drawn.getPageIndices())) out.addPage(page);
  return withPdfDecodeBudget(() => out.save({ useObjectStreams: false }));
}

/**
 * Step 9: the written file must be a pdf-lib fixed point (a reload and save
 * gives the same bytes) with the same page count, read under the strict page
 * walk the seal uses, and pass the sealed-file structure check. Either
 * failing is a bug in this pipeline, so the upload is refused rather than
 * stored. Returns the reloaded document.
 */
async function selfCheck(bytes: Uint8Array, pageCount: number): Promise<PDFDocument> {
  let reloaded: PDFDocument;
  try {
    reloaded = await loadPdfWithDecodeLimits(bytes, {
      updateMetadata: false,
      pageTreeMode: 'sealed',
      maxParseObjects: sealedMaxParseObjects(),
    });
    const again = await withPdfDecodeBudget(() =>
      reloaded.save({ useObjectStreams: false, updateFieldAppearances: false }),
    );
    if (!sameBytes(again, bytes) || reloaded.getPageCount() !== pageCount) refuse('self_check');
    await checkPdfStructure(bytes);
  } catch (err) {
    if (err instanceof Refusal || isLimitError(err)) throw err;
    return refuse('self_check');
  }
  return reloaded;
}

async function canonicalize(bytes: Uint8Array, ignoreEncryption: boolean): Promise<CanonicalizeResult> {
  const source = await loadSource(bytes, ignoreEncryption);
  // 2. Nothing to sign.
  const pageCount = source.getPageCount();
  if (pageCount < 1) refuse('no_pages');
  // 3. Viewers would redraw the fields from /V; the flattener draws /AP.
  assertNoNeedAppearances(source);

  const written = await withSeededRandom(async () => {
    // 4.
    await flattenForm(source);
    // 5. What is still on a page after flattening, or layered, the seal would not show alike.
    const leaves = pageTreeLeaves(source, { mode: 'source', maxPages: getPdfSealLimits().maxPages });
    assertNoVisibleAnnotations(source, leaves);
    // Layers that are all on are dropped with the rest of the catalog: the
    // canonical document is new, and only the pages are copied into it.
    optionalContentPolicy(source, leaves);
    // Bound the copy before doing it, as sealing does on the same document.
    assertSealCost(source);
    // 6-8.
    return writeCanonical(source);
  });

  const canonical = await selfCheck(written, pageCount);
  // 10. What sealing will copy out of the canonical file.
  const sealCost = assertSealCost(canonical);
  return { ok: true, bytes: written, pageCount, sealCost };
}

/**
 * Canonicalize an upload, or say why it is refused. Never throws for a
 * property of the PDF: decode and complexity limits are `pdf_too_complex`, the
 * source policy's findings carry their own key, and anything else pdf-lib
 * throws while reading or copying the pages is `unreadable_pdf`.
 */
export async function canonicalizeUploadedPdf(
  bytes: Uint8Array,
  opts: { ignoreEncryption?: boolean } = {},
): Promise<CanonicalizeResult> {
  try {
    return await canonicalize(bytes, opts.ignoreEncryption === true);
  } catch (err) {
    if (err instanceof Refusal) return err.result;
    if (err instanceof SourcePolicyError) return { ok: false, key: err.reason };
    if (isLimitError(err)) return { ok: false, key: 'pdf_too_complex' };
    return { ok: false, key: 'unreadable_pdf' };
  }
}
