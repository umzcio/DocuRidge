/**
 * The render half of sealing: everything that parses, copies and draws PDF
 * content, run in the PDF worker child (src/lib/pdf-worker) as the `'seal'`
 * job. `buildSealedEnvelope` (seal.ts) reads the envelope and each
 * document's canonical copy in the parent and hands them over as plain data;
 * the child checks each copy, copies its pages into one output, stamps the
 * fields, draws the audit page, saves the body, digests it, and asks the
 * parent once, through `signManifest`, for the signed manifest to attach.
 * The org key never leaves the parent.
 *
 * The child is sandboxed: no filesystem reads, no database, no secrets in
 * its environment, no child processes or worker threads. So this module, and
 * everything it imports at runtime, must not read files or import
 * `../prisma`, `../env`, `../crypto/*`, `../audit/*` or `../logger` (pino
 * may start worker-thread transports). Type-only imports are fine. Events
 * the old in-process sealer logged come back as `SealRenderWarning` data,
 * which the parent logs.
 */

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { PdfJobContext } from '../pdf-worker/protocol';
import { assertSealImagePixels, embedCachedImage, sealImageSet, type ImageEmbedCache } from '../signing/signature-image';
import { checkPdfStructure } from '../verify/pdf-structure';
import {
  CURRENT_SEALED_CONTENT_DIGEST_VERSION,
  sealedContentDigestFromBytes,
  type SealedContentDigest,
} from './content-digest';
import { uiToPdf } from './coords';
import { PdfDecodeLimitError, loadPdfWithDecodeLimits, withPdfDecodeBudget } from './decode-limits';
import { SealedContentStructureError, sealedMaxParseObjects } from './page-tree';
import {
  PdfComplexityError,
  assertEnvelopeItemCount,
  assertEnvelopeSealCost,
  assertSealCost,
  type PdfSealCost,
} from './seal-limits';

/** A field to stamp, as the parent read it, with Prisma `Decimal` coordinates turned into numbers. */
export interface SealRenderField {
  type: string;
  /** 1-indexed page within its document. */
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  value: string | null;
  recipientId: string;
  /** JSON meta — used by NOTE (text), STAMP (image), and others. */
  meta?: unknown;
}

export interface SealRenderRecipient {
  id: string;
  name: string;
  email: string;
  signatures: Array<{ imagePngBase64: string | null; typedSignature: string | null; fieldId: string | null }>;
}

/** Exactly what the audit page draws. Dates stay Dates (the IPC clone keeps them). */
export interface AuditPageData {
  id: string;
  title: string;
  createdBy: { name: string | null; email: string | null } | null;
  org: { name: string } | null;
  /** `documentFile.sha256` is the uploaded file's; `canonicalSha256` its canonical copy's, which was sealed. */
  items: Array<{ title: string; documentFile: { sha256: string }; canonicalSha256: string }>;
  recipients: Array<{ name: string; email: string; signingStatus: string; signedAt: Date | null }>;
  /** The envelope's fields; the page lists those of type ATTACHMENT that have an attachment. */
  fields: Array<{
    type: string;
    recipient: { name: string } | null;
    attachment: { filename: string; sha256: string; sizeBytes: number } | null;
  }>;
  auditEvents: Array<{ createdAt: Date; type: string; actorEmail: string | null; actorName: string | null }>;
}

export interface SealRenderInput {
  /** Org default font for typed field text; the audit page always uses Helvetica. */
  fieldFont: 'sans' | 'serif' | 'mono';
  /** The envelope's documents in order: each canonical copy's bytes and the fields placed on them. */
  items: Array<{ bytes: Uint8Array; fields: SealRenderField[] }>;
  recipients: SealRenderRecipient[];
  /**
   * Every field on the envelope, keyed by id. Used to resolve which Signature
   * row goes with each field (signature vs initials).
   */
  fieldsById: Record<string, { type: string }>;
  auditPage: AuditPageData;
}

export type SealRenderWarningKind =
  | 'signature_image_embed_failed'
  | 'drawing_image_embed_failed'
  | 'stamp_image_embed_failed';

/**
 * Something the sealed document is missing that the sender should know of
 * (a signature drawn as typed text, a blank DRAWING or STAMP box). No free
 * text: the parent logs it with a fixed message.
 */
export interface SealRenderWarning {
  kind: SealRenderWarningKind;
  recipientId: string;
  fieldType: string;
}

/** What the `'seal'` job returns to the parent. */
export interface SealJobOutput {
  bytes: Uint8Array;
  warnings: SealRenderWarning[];
}

/**
 * Render an envelope's sealed PDF from `input`.
 *
 *   - Copies each document's canonical pages, in order and unchanged, into
 *     one output, stamps the fields on top of them, then appends the
 *     human-readable audit page.
 *   - Saves the body and takes the per-page sealed-content digest from those
 *     bytes, then calls `signManifest` exactly once with it. The callback
 *     returns the signed manifest's JSON bytes, which are attached; the
 *     function returns the final file.
 *
 * Every parse and decode runs under the seal-limits.ts and decode-limits.ts
 * caps, so a document over them throws `PdfComplexityError` /
 * `PdfDecodeLimitError` before `signManifest` is called.
 */
export async function renderSealedEnvelope(
  input: SealRenderInput,
  signManifest: (sealedContent: SealedContentDigest) => Promise<Uint8Array>,
  options: { onWarning?: (warning: SealRenderWarning) => void } = {},
): Promise<Uint8Array> {
  const onWarning = options.onWarning ?? (() => {});
  const out = await PDFDocument.create();
  // Org-wide default font for typed text fields. Falls back to Helvetica
  // when unset or unrecognized. Audit page always uses Helvetica/-Bold so
  // the certificate stays consistent across orgs.
  const fieldFontStandard =
    input.fieldFont === 'serif' ? StandardFonts.TimesRoman :
    input.fieldFont === 'mono'  ? StandardFonts.Courier   :
    StandardFonts.Helvetica;
  const helv = await out.embedFont(fieldFontStandard);
  const helvBold = await out.embedFont(StandardFonts.HelveticaBold);

  // Each item is its canonical copy (canonicalize.ts): the uploaded
  // document's pages, form flattened, each embedded as a Form XObject and
  // drawn upright onto a fresh page whose content is that one balanced draw.
  // Copying those pages unchanged and stamping on top seals exactly what the
  // signers were shown. Appending draw ops to a copied page used to be
  // unsafe (pdfjs could fail to render ops after a source's graphics-state or
  // clipping leftovers), but a canonical page's content is our own `q cm Do
  // Q`, and pdf-lib brackets it in a further q/Q before the first stamp, so
  // the stamps are top-level operators every renderer agrees on.
  // Envelope-wide caps (seal-limits.ts): the documents' summed seal cost is
  // bounded as at upload and send, checked before each document is copied.
  assertEnvelopeItemCount(input.items.length);
  assertSealImagePixels(sealImageSet(input.recipients, input.items.flatMap((item) => item.fields)));
  const imageCache: ImageEmbedCache = new Map();
  const itemCosts: PdfSealCost[] = [];
  for (const item of input.items) {
    // The copy must still be what canonicalization wrote: one pdf-lib
    // revision that every reader resolves alike, with a page tree every
    // reader walks alike. A file changed on disk, or written by anything
    // else, is refused here rather than sealed. Decode limits apply to the
    // parse as to any stored file, which must fail cleanly rather than
    // inflate without bound.
    await sourceStep(() => checkPdfStructure(item.bytes), CANONICAL_STRUCTURE_MESSAGE);
    const source = await sourceStep(() =>
      loadPdfWithDecodeLimits(item.bytes, { pageTreeMode: 'sealed', maxParseObjects: sealedMaxParseObjects() }),
    );
    await sourceStep(async () => assertCanonicalPages(source), CANONICAL_STRUCTURE_MESSAGE);
    // The copy below is capped (seal-limits.ts) by the same ceilings the
    // canonical copy was checked against when it was made.
    itemCosts.push(assertSealCost(source));
    assertEnvelopeSealCost(itemCosts);

    // One copy pass per document, so resources shared between its pages are
    // copied into the sealed output once, not once per page, under this
    // document's own decode budget. A canonical page is upright with its
    // origin at zero, at the size PDF.js displayed the uploaded page, which
    // is what field coordinates refer to.
    const pages = await sourceStep(() =>
      withPdfDecodeBudget(async () => {
        const copied = await out.copyPages(source, source.getPageIndices());
        return copied.map((page) => out.addPage(page));
      }),
    );
    for (const [i, page] of pages.entries()) {
      const pageNumber = i + 1; // 1-indexed within the source item
      for (const field of item.fields) {
        if (field.page !== pageNumber) continue;
        await stampField({
          doc: out,
          page,
          field,
          recipients: input.recipients,
          fieldsById: input.fieldsById,
          font: helv,
          imageCache,
          onWarning,
        });
      }
    }
    // Flush whatever is still lazy per item, and keep page decodes (above)
    // per item too, so each document's decode is bounded by its own budget,
    // as it was when its upload was accepted; one budget for the whole
    // envelope would refuse documents that each passed upload, after the last
    // signer had already committed.
    await withPdfDecodeBudget(() => out.flush());
  }

  // Append the human-readable audit page.
  drawAuditPage(out.addPage(), input.auditPage, helv, helvBold);

  // The manifest must cover the rendered pages, so the digest has to be taken
  // from serialized bytes (in-memory pages hold PDFContentStream, which the
  // digest can't read). Attaching the manifest afterwards does not perturb
  // per-page digests, so this pre-attachment save is the binding point.
  // Source pages were embedded (and their decodes bounded) per item above;
  // anything still pending is bounded here like any other untrusted decode.
  //
  // Both saves write a classic cross-reference table and no object streams.
  // Re-reading the file (the digest below, and every later verify) then
  // decodes nothing at parse time, so the one decode budget that covers a
  // re-read does not have to hold every document's objects: with object
  // streams, an envelope of documents that each passed their own budget
  // could not be re-read under one. The v3 digest hashes streams as stored
  // and numbers objects canonically, so it is the same for both layouts.
  const bodyBytes = await withPdfDecodeBudget(() => out.save({ useObjectStreams: false }));
  const sealedContent = await sealedContentDigestFromBytes(bodyBytes, CURRENT_SEALED_CONTENT_DIGEST_VERSION);

  // The parent builds and signs the manifest; embed it as a PDF attachment.
  const manifestBytes = await signManifest(sealedContent);
  await out.attach(manifestBytes, 'docuridge-manifest.json', {
    mimeType: 'application/json',
    description: 'DocuRidge cryptographic manifest',
    creationDate: new Date(),
    modificationDate: new Date(),
  });

  return out.save({ useObjectStreams: false });
}

/** The fixed message for a source document pdf-lib could not read or copy. */
const SOURCE_STRUCTURE_MESSAGE = 'Malformed page tree: a page of a source document cannot be copied into the sealed document.';
/** The fixed message for a canonical copy that is not the file canonicalization writes (structure or page layout). */
const CANONICAL_STRUCTURE_MESSAGE = "A document's canonical copy is not the file DocuRidge wrote, so it cannot be sealed.";

/** The entries canonicalization writes on a page. `copyPages` would carry any other one into the seal. */
const CANONICAL_PAGE_KEYS = new Set(['/Type', '/Parent', '/MediaBox', '/Resources', '/Contents', '/Annots']);

/**
 * Throws unless every page is one canonicalization writes, so it can be
 * copied as it is and stamped:
 *
 *   - Layout: its /MediaBox at the origin with a positive, finite size, no
 *     other /CropBox, no /Rotate and no /UserUnit. Fields are stamped by the
 *     page's size alone (`uiToPdf`), which puts them where the signer saw
 *     them only on such a page; the old pipeline drew every page upright
 *     here, the canonical copy already is.
 *   - Entries: none but those in CANONICAL_PAGE_KEYS (no /AA, /Group,
 *     /Metadata, ...), and an empty /Annots, since the copy keeps whatever
 *     the page holds.
 *   - Types: what pdf-lib reads when it first draws on a page (`normalize`)
 *     has the type it expects: /Resources and its /Font, /XObject and
 *     /ExtGState are dictionaries, and /Contents is a stream or an array of
 *     streams. Otherwise the first stamp would throw outside `sourceStep`,
 *     as a retryable error rather than a document to replace.
 */
function assertCanonicalPages(source: PDFDocument): void {
  const { context } = source;
  const fail = (): never => {
    throw new Error('page is not one canonicalization writes');
  };
  for (const page of source.getPages()) {
    const node = page.node;
    const media = page.getMediaBox();
    const crop = page.getCropBox();
    const upright =
      media.x === 0 && media.y === 0 &&
      Number.isFinite(media.width) && media.width > 0 &&
      Number.isFinite(media.height) && media.height > 0 &&
      crop.x === media.x && crop.y === media.y && crop.width === media.width && crop.height === media.height &&
      page.getRotation().angle === 0;
    if (!upright) fail();
    if (node.keys().some((key) => !CANONICAL_PAGE_KEYS.has(key.asString()))) fail();

    const resources = context.lookup(node.getInheritableAttribute(PDFName.of('Resources')));
    if (resources !== undefined) {
      if (!(resources instanceof PDFDict)) fail();
      for (const name of ['Font', 'XObject', 'ExtGState']) {
        const entry = (resources as PDFDict).get(PDFName.of(name));
        if (entry !== undefined && !(context.lookup(entry) instanceof PDFDict)) fail();
      }
    }
    const annots = node.get(PDFName.of('Annots'));
    if (annots !== undefined) {
      const resolved = context.lookup(annots);
      if (!(resolved instanceof PDFArray) || resolved.size() !== 0) fail();
    }
    const contents = node.get(PDFName.of('Contents'));
    if (contents !== undefined) {
      const resolved = context.lookup(contents);
      const streams = resolved instanceof PDFArray ? resolved.asArray() : [resolved];
      if (!streams.every((stream) => context.lookup(stream) instanceof PDFStream)) fail();
    }
  }
}

/**
 * Run one step that reads a source document (structure check, load, page
 * copy). The limit and structure errors pass through; anything else thrown
 * on the untrusted file becomes `SealedContentStructureError` with a fixed
 * message (no pdf-lib text), so a stored file the upload checks did not
 * catch fails the seal as a document to replace, not as "try again". Only
 * these steps are wrapped: stamping, the audit page and the digest are our
 * own code, and an error there stays a real error.
 */
async function sourceStep<T>(step: () => Promise<T>, message = SOURCE_STRUCTURE_MESSAGE): Promise<T> {
  try {
    return await step();
  } catch (err) {
    if (
      err instanceof PdfComplexityError ||
      err instanceof PdfDecodeLimitError ||
      err instanceof SealedContentStructureError
    ) {
      throw err;
    }
    throw new SealedContentStructureError(message);
  }
}

/**
 * The `'seal'` job handler (registered in src/lib/pdf-worker/jobs.ts). The
 * one question it asks the parent is `{ sealedContent }`; the answer must
 * be the signed manifest's bytes.
 */
export async function runSealJob(
  input: SealRenderInput,
  ctx: Pick<PdfJobContext, 'askParent'>,
): Promise<SealJobOutput> {
  const warnings: SealRenderWarning[] = [];
  const bytes = await renderSealedEnvelope(
    input,
    async (sealedContent) => {
      const reply = await ctx.askParent({ sealedContent });
      if (!(reply instanceof Uint8Array)) throw new Error('The parent did not return a signed manifest');
      return reply;
    },
    { onWarning: (warning) => warnings.push(warning) },
  );
  return { bytes, warnings };
}

async function stampField(args: {
  doc: PDFDocument;
  page: PDFPage;
  field: SealRenderField;
  recipients: SealRenderRecipient[];
  /**
   * All fields on the envelope, keyed by id. Used to resolve which Signature
   * row goes with each field — one row anchored to a SIGNATURE field is the
   * adopted full signature, one anchored to an INITIALS field is the adopted
   * initials. Both belong to the same recipient but stamp different marks.
   */
  fieldsById: Record<string, { type: string }>;
  font: PDFFont;
  /** Images embedded so far in this seal, so each distinct image is decoded once. */
  imageCache: ImageEmbedCache;
  /** Reports a mark that could not be drawn (the parent logs it). */
  onWarning: (warning: SealRenderWarning) => void;
}): Promise<void> {
  const { doc, page, field, recipients, fieldsById, font, imageCache, onWarning } = args;
  const recipient = recipients.find((r) => r.id === field.recipientId);
  // Pick the Signature row whose anchor field matches THIS field's type.
  // Falls back to the first row when there's no type match (legacy data
  // before separate signature/initials capture).
  const signature = (() => {
    if (!recipient) return undefined;
    const matching = recipient.signatures.find((s) => {
      if (!s.fieldId) return false;
      const anchorType = fieldsById[s.fieldId]?.type;
      return anchorType === field.type;
    });
    return matching ?? recipient.signatures[0];
  })();
  const pw = page.getWidth();
  const ph = page.getHeight();
  const box = uiToPdf({ x: field.x, y: field.y, w: field.w, h: field.h }, pw, ph);

  switch (field.type) {
    case 'SIGNATURE':
    case 'INITIALS': {
      if (signature?.imagePngBase64) {
        try {
          const img = await embedCachedImage(doc, signature.imagePngBase64, ['png'], imageCache);
          const scaled = img.scaleToFit(box.width, box.height);
          page.drawImage(img, {
            x: box.x + (box.width - scaled.width) / 2,
            y: box.y + (box.height - scaled.height) / 2,
            width: scaled.width,
            height: scaled.height,
          });
          return;
        } catch {
          // A completed, sealed document with a blank signature box is a
          // correctness failure, not a cosmetic one — the parent logs this at
          // error level so it is visible without reading warn-level noise.
          onWarning({ kind: 'signature_image_embed_failed', recipientId: field.recipientId, fieldType: field.type });
        }
      }
      if (signature?.typedSignature) {
        drawCenteredText(page, signature.typedSignature, box, font);
      }
      return;
    }
    case 'DATE': {
      drawCenteredText(page, field.value || new Date().toISOString().slice(0, 10), box, font);
      return;
    }
    case 'CHECKBOX': {
      if ((field.value || '').toLowerCase() === 'true') {
        // Draw a vector checkmark — pdf-lib's standard WinAnsi-encoded fonts
        // (Helvetica/TimesRoman/etc.) cannot encode the U+2713 glyph. Two
        // strokes ("\" then "/" inverted) inside the box, scaled to ~70%.
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        const r = Math.min(box.width, box.height) * 0.32;
        const thickness = Math.max(1.4, Math.min(box.width, box.height) * 0.12);
        // Bottom-of-V point
        const vx = cx - r * 0.15;
        const vy = cy - r * 0.55;
        page.drawLine({
          start: { x: cx - r * 0.85, y: cy - r * 0.05 },
          end:   { x: vx,            y: vy },
          thickness,
          color: rgb(0, 0, 0),
        });
        page.drawLine({
          start: { x: vx,           y: vy },
          end:   { x: cx + r * 0.85, y: cy + r * 0.65 },
          thickness,
          color: rgb(0, 0, 0),
        });
      }
      return;
    }
    case 'NAME': {
      drawCenteredText(page, recipient?.name || '', box, font);
      return;
    }
    case 'EMAIL': {
      drawCenteredText(page, recipient?.email || '', box, font);
      return;
    }
    case 'JOB_TITLE':
    case 'PHONE':
    case 'COMPANY':
    case 'TEXT':
    case 'NUMBER':
    case 'FORMULA':
    case 'DROPDOWN':
    case 'RADIO':
    case 'APPROVE':
      drawCenteredText(page, field.value ?? '', box, font);
      return;
    case 'NOTE': {
      // Sender-authored static annotation; pull text from meta.
      const meta = field.meta as { noteText?: string } | null | undefined;
      const note = meta?.noteText ?? '';
      drawWrappedLines(page, note, box, font);
      return;
    }
    case 'DECLINE':
      // Recipient didn't click it (otherwise the envelope would be DECLINED,
      // not COMPLETED). No stamp.
      return;
    case 'LINE': {
      // Sender-drawn annotation: a black horizontal line spanning the field
      // box width, vertically centered. Stroke thickness scaled to the box
      // height with sensible bounds.
      const cy = box.y + box.height / 2;
      const thickness = Math.max(0.7, Math.min(box.height * 0.6, 2.5));
      page.drawLine({
        start: { x: box.x, y: cy },
        end:   { x: box.x + box.width, y: cy },
        thickness,
        color: rgb(0, 0, 0),
      });
      return;
    }
    case 'DRAWING': {
      // Recipient-drawn freeform mark stored as a base64 data URL in
      // field.value. Embed as PNG (the ceremony always exports PNG, and the
      // ceremony action validates DRAWING values as PNG-only before they
      // ever reach here) and scale-to-fit the placed field box.
      const v = field.value ?? '';
      if (!v) return;
      const m = v.match(/^data:image\/png;base64,(.+)$/);
      const b64 = m ? m[1]! : v;
      try {
        const img = await embedCachedImage(doc, b64, ['png'], imageCache);
        const scaled = img.scaleToFit(box.width, box.height);
        page.drawImage(img, {
          x: box.x + (box.width - scaled.width) / 2,
          y: box.y + (box.height - scaled.height) / 2,
          width: scaled.width,
          height: scaled.height,
        });
      } catch {
        // A completed, sealed document with an empty DRAWING box is a
        // correctness failure, not a cosmetic one — the parent logs it at
        // error level so it is visible without reading warn-level noise.
        onWarning({ kind: 'drawing_image_embed_failed', recipientId: field.recipientId, fieldType: field.type });
      }
      return;
    }
    case 'STAMP': {
      // Sender-uploaded image embedded once into the doc. Picks PNG vs JPEG
      // embed from the bytes themselves (re-checked here, as at upload).
      const meta = (field.meta && typeof field.meta === 'object'
        ? field.meta as { stampImageBase64?: string; stampMimeType?: string }
        : {});
      if (!meta.stampImageBase64) return;
      try {
        const img = await embedCachedImage(doc, meta.stampImageBase64, ['png', 'jpeg'], imageCache);
        const scaled = img.scaleToFit(box.width, box.height);
        page.drawImage(img, {
          x: box.x + (box.width - scaled.width) / 2,
          y: box.y + (box.height - scaled.height) / 2,
          width: scaled.width,
          height: scaled.height,
        });
      } catch {
        // Same reasoning as the DRAWING case above: a blank sender stamp on a
        // completed document is a correctness failure.
        onWarning({ kind: 'stamp_image_embed_failed', recipientId: field.recipientId, fieldType: field.type });
      }
      return;
    }
    case 'ADDRESS': {
      // Multi-line: render each line top-to-bottom inside the box.
      drawWrappedLines(page, field.value ?? '', box, font);
      return;
    }
    default: {
      drawCenteredText(page, field.value ?? '', box, font);
      return;
    }
  }
}

/**
 * pdf-lib's standard fonts (Helvetica/Times/Courier) use WinAnsi encoding,
 * which only covers U+0000–U+00FF (plus a handful of mapped chars). User
 * input frequently contains em-dashes, smart quotes, ellipses, accented
 * letters, or arbitrary unicode that would throw at draw time. This
 * sanitizer maps common offenders to ASCII equivalents and replaces
 * everything else above U+00FF with "?" so we never call drawText with
 * an unencodable char. Long-term fix: embed a TrueType unicode font.
 */
function winAnsiSafe(text: string): string {
  return text
    // Common typographic substitutions
    .replace(/[‐-―]/g, '-')   // hyphens, dashes (–, —, ―)
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/…/g, '...')
    .replace(/•/g, '*')
    .replace(/[✓✔]/g, '[x]')
    .replace(/[   ]/g, ' ')
    // Anything else above the WinAnsi range → "?"
    .replace(/[^ -ÿ]/g, '?');
}

function drawCenteredText(
  page: PDFPage,
  text: string,
  box: { x: number; y: number; width: number; height: number },
  font: PDFFont,
) {
  if (!text) return;
  const safe = winAnsiSafe(text);
  let size = Math.min(box.height * 0.7, 14);
  for (let i = 0; i < 6; i++) {
    const w = font.widthOfTextAtSize(safe, size);
    if (w <= box.width * 0.95) break;
    size *= 0.85;
  }
  const w = font.widthOfTextAtSize(safe, size);
  page.drawText(safe, {
    x: box.x + (box.width - w) / 2,
    y: box.y + (box.height - size) / 2,
    size,
    font,
    color: rgb(0, 0, 0),
  });
}

/**
 * Render multi-line text top-down inside the box. Used by ADDRESS fields and
 * any future free-form multi-line value. Splits on user-provided newlines and
 * shrinks size until each line fits the width.
 */
function drawWrappedLines(
  page: PDFPage,
  text: string,
  box: { x: number; y: number; width: number; height: number },
  font: PDFFont,
) {
  if (!text) return;
  const rawLines = winAnsiSafe(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (rawLines.length === 0) return;
  const lineHeightFactor = 1.25;
  let size = Math.min(box.height / (rawLines.length * lineHeightFactor), 12);
  for (let i = 0; i < 6; i++) {
    const widest = Math.max(...rawLines.map((l) => font.widthOfTextAtSize(l, size)));
    if (widest <= box.width * 0.95) break;
    size *= 0.85;
  }
  const lineH = size * lineHeightFactor;
  const totalH = rawLines.length * lineH;
  const startY = box.y + (box.height + totalH) / 2 - size;
  for (let i = 0; i < rawLines.length; i++) {
    page.drawText(rawLines[i]!, {
      x: box.x + 4,
      y: startY - i * lineH,
      size,
      font,
      color: rgb(0, 0, 0),
    });
  }
}

/** `text`, or as much of it as fits in `width` followed by "...". */
function fitText(text: string, width: number, font: PDFFont, size: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let end = text.length;
  while (end > 0 && font.widthOfTextAtSize(`${text.slice(0, end)}...`, size) > width) end--;
  return end > 0 ? `${text.slice(0, end)}...` : '';
}

function drawAuditPage(
  page: PDFPage,
  env: AuditPageData,
  helv: PDFFont,
  helvBold: PDFFont,
) {
  const { height } = page.getSize();
  let cursor = height - 50;

  page.drawText('Document Audit Trail', {
    x: 50,
    y: cursor,
    size: 18,
    font: helvBold,
    color: rgb(0.1, 0.2, 0.25),
  });
  cursor -= 28;

  page.drawText(winAnsiSafe(`Envelope: ${env.title}`), { x: 50, y: cursor, size: 11, font: helvBold, color: rgb(0, 0, 0) });
  cursor -= 14;
  page.drawText(winAnsiSafe(`ID: ${env.id}`), { x: 50, y: cursor, size: 9, font: helv, color: rgb(0.3, 0.3, 0.3) });
  cursor -= 12;
  page.drawText(winAnsiSafe(`Sender: ${env.createdBy?.name ?? '(unknown)'} (${env.createdBy?.email ?? '?'})`), {
    x: 50, y: cursor, size: 10, font: helv, color: rgb(0, 0, 0),
  });
  cursor -= 12;
  page.drawText(winAnsiSafe(`Organisation: ${env.org?.name ?? '?'}`), { x: 50, y: cursor, size: 10, font: helv, color: rgb(0, 0, 0) });
  cursor -= 22;

  page.drawText('Documents', { x: 50, y: cursor, size: 12, font: helvBold, color: rgb(0, 0, 0) });
  cursor -= 14;
  // One 12pt line per document, as before the signed copy's hash was added,
  // so a full envelope still leaves room for the sections below: the full
  // signed-copy hash in a smaller size, and the title shortened to fit.
  const documentLineSize = 7;
  const documentLineWidth = page.getWidth() - 100;
  for (const it of env.items) {
    const hashes = `  sha256:${it.documentFile.sha256.slice(0, 12)}...  Signed copy SHA-256: ${it.canonicalSha256}`;
    const room = documentLineWidth - helv.widthOfTextAtSize(`- ${hashes}`, documentLineSize);
    const title = fitText(winAnsiSafe(it.title), room, helv, documentLineSize);
    page.drawText(`- ${title}${hashes}`, {
      x: 50, y: cursor, size: documentLineSize, font: helv, color: rgb(0.1, 0.1, 0.1),
    });
    cursor -= 12;
  }
  cursor -= 8;

  page.drawText('Recipients', { x: 50, y: cursor, size: 12, font: helvBold, color: rgb(0, 0, 0) });
  cursor -= 14;
  for (const r of env.recipients) {
    page.drawText(
      winAnsiSafe(`- ${r.name} <${r.email}>  ${r.signingStatus}${r.signedAt ? ' at ' + new Date(r.signedAt).toUTCString() : ''}`),
      { x: 50, y: cursor, size: 9, font: helv, color: rgb(0.1, 0.1, 0.1) },
    );
    cursor -= 12;
  }
  cursor -= 10;

  // Recipient-uploaded attachments — list per-field with the SHA-256 prefix
  // so the audit chain pins the exact file content. The bytes themselves
  // live in storage; this page is the human-readable trail. Skip cleanly if
  // the envelope has none.
  const attachmentRows = env.fields.filter((f) => f.type === 'ATTACHMENT' && f.attachment);
  if (attachmentRows.length > 0) {
    page.drawText('Attachments', { x: 50, y: cursor, size: 12, font: helvBold, color: rgb(0, 0, 0) });
    cursor -= 14;
    for (const f of attachmentRows) {
      const a = f.attachment!;
      const kb = Math.max(1, Math.round(a.sizeBytes / 1024));
      const who = f.recipient?.name ?? '';
      page.drawText(
        winAnsiSafe(`- ${a.filename}  ${kb} KB  sha256:${a.sha256.slice(0, 12)}...  by ${who}`),
        { x: 50, y: cursor, size: 9, font: helv, color: rgb(0.1, 0.1, 0.1) },
      );
      cursor -= 12;
      if (cursor < 60) break;
    }
    cursor -= 10;
  }

  page.drawText('Events', { x: 50, y: cursor, size: 12, font: helvBold, color: rgb(0, 0, 0) });
  cursor -= 14;
  for (const e of env.auditEvents) {
    if (cursor < 60) break;
    const ts = new Date(e.createdAt).toISOString();
    const actor = e.actorEmail ?? e.actorName ?? '';
    page.drawText(winAnsiSafe(`${ts}  ${e.type}  ${actor}`), {
      x: 50, y: cursor, size: 8, font: helv, color: rgb(0.1, 0.1, 0.1),
    });
    cursor -= 11;
  }
}
