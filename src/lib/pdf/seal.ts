import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from 'pdf-lib';
import { prisma } from '../prisma';
import { readPdfFromStorage, stageSealedPdf } from '../storage';
import { uiToPdf } from './coords';
import {
  canonicalJson,
  commitWithEnvelopeEvents,
  prepareEnvelopeEvent,
  type AppendedEnvelopeEvent,
  type PreparedEnvelopeEvent,
} from '../audit/envelope';
import { sha256Hex } from '../util';
import { childLogger } from '../logger';
import { getOrCreateOrgKey, signHex } from '../crypto/org-key';
import {
  CURRENT_SEALED_CONTENT_DIGEST_VERSION,
  sealedContentDigestFromBytes,
  type SealedContentDigest,
} from './content-digest';
import { appendUprightPages } from './upright-page';
import { assertEnvelopeItemCount, assertEnvelopeSealCost, assertSealCost, type PdfSealCost } from './seal-limits';
import { flattenPdfFormAppearances } from './form-appearance';
import { embedStoredImage } from '../signing/signature-image';
import { loadPdfWithDecodeLimits, withPdfDecodeBudget } from './decode-limits';

const log = childLogger({ module: 'pdf-seal' });

/**
 * A sealed document built in memory and not yet stored anywhere: the output
 * of `buildSealedEnvelope`, the input of `persistSealedEnvelope`.
 */
export interface SealedBuild {
  envelopeId: string;
  orgId: string;
  bytes: Buffer;
  sha256: string;
  manifest: Record<string, unknown>;
  manifestSignature: string;
  chainHeadHash: string;
  signedByKeyId: string;
  sourceDocumentCount: number;
  /**
   * The recipients exactly as the manifest and audit page record them, so a
   * caller can check, under the envelope's row lock, that nothing the seal
   * describes changed after the build read it.
   */
  recipients: SealedRecipient[];
  /**
   * Built with `completion`: the `envelope.completed` event the seal ends
   * with, which the completion claim must store exactly as is.
   */
  completionEvent?: PreparedEnvelopeEvent;
}

export interface SealedRecipient {
  id: string;
  name: string;
  email: string;
  role: string;
  signingOrder: number;
  signingStatus: string;
  signedAt: string | null;
}

/**
 * Build an envelope's sealed PDF, without side effects.
 *
 *   - For multi-document envelopes, copies each source PDF's pages into a
 *     single output PDF in the order the user uploaded them, stamps fields
 *     onto each, then appends a human-readable audit page and embeds a
 *     signed JSON manifest as a PDF attachment.
 *   - Document hashes (source SHA-256 of each input file) are recorded in
 *     the manifest, plus the chain head, so a verifier can confirm the seal
 *     bound the exact inputs. The manifest also carries a per-page digest of
 *     the rendered output (see content-digest.ts), so a verifier can detect
 *     tampering with the sealed document's body, not just its inputs.
 *
 * This is the expensive, failure-prone half of sealing (source parsing, form
 * flattening, page copies under the seal-limits.ts caps), so it writes
 * nothing: no file, no row, no audit event. Completion runs it BEFORE it
 * claims the envelope and throws the result away if the claim loses; see
 * `persistSealedEnvelope` for the other half.
 *
 * The sealed audit chain always ends with `envelope.completed`. For an
 * envelope that is not completed yet, pass `completion`: the event the claim
 * will record is computed here (hashed and signed after the current chain
 * head, `createdAt` = `completedAt`) and sealed into the manifest, the Events
 * page and the chain head; the claim then stores exactly that event, and
 * only while the chain head is still the one it follows (`completionEvent`).
 * Without `completion` (a COMPLETED envelope), the stored chain already ends
 * with that event, so either path seals identical evidence.
 */
export async function buildSealedEnvelope(args: {
  envelopeId: string;
  completion?: {
    completedAt: Date;
    actor: { ipAddress?: string | null; userAgent?: string | null; actorUserId?: string | null };
  };
}): Promise<SealedBuild> {
  const env = await prisma.envelope.findUnique({
    where: { id: args.envelopeId },
    include: {
      org: true,
      createdBy: true,
      items: { include: { documentFile: true }, orderBy: { order: 'asc' } },
      recipients: { orderBy: { signingOrder: 'asc' }, include: { signatures: true } },
      fields: { include: { attachment: true, recipient: { select: { name: true, email: true } } } },
      auditEvents: { orderBy: { seq: 'asc' } },
    },
  });
  if (!env) throw new Error('Envelope not found for sealing');
  const orgKey = await getOrCreateOrgKey(env.orgId);
  const head = env.auditEvents[env.auditEvents.length - 1];
  const completionEvent = args.completion
    ? await prepareEnvelopeEvent({
        key: orgKey,
        prior: head ? { seq: head.seq, eventHash: head.eventHash } : null,
        createdAt: args.completion.completedAt,
        event: { envelopeId: env.id, type: 'envelope.completed', ...args.completion.actor },
      })
    : undefined;
  const auditEvents = completionEvent ? [...env.auditEvents, completionEvent] : env.auditEvents;
  // What the seal records: the manifest, the Events page and the chain head.
  const sealedEnv = {
    ...env,
    completedAt: args.completion?.completedAt ?? env.completedAt ?? null,
    auditEvents,
  };

  const out = await PDFDocument.create();
  // Org-wide default font for typed text fields. Falls back to Helvetica
  // when unset or unrecognized. Audit page always uses Helvetica/-Bold so
  // the certificate stays consistent across orgs.
  const fieldFontKey = (env.org as { defaultFieldFont?: string | null }).defaultFieldFont ?? 'sans';
  const fieldFontStandard =
    fieldFontKey === 'serif' ? StandardFonts.TimesRoman :
    fieldFontKey === 'mono'  ? StandardFonts.Courier   :
    StandardFonts.Helvetica;
  const helv = await out.embedFont(fieldFontStandard);
  const helvBold = await out.embedFont(StandardFonts.HelveticaBold);

  // Index of every field by id, so the stamper can resolve which Signature
  // row goes with which field type (signature vs initials).
  const fieldsById: Record<string, { type: string }> = {};
  for (const f of env.fields) fieldsById[f.id] = { type: f.type };

  // We embed each source page as a Form XObject and draw it onto a fresh
  // page, then stamp signatures on top. This is the pattern DocuSign /
  // Adobe Sign use, and it avoids a known pdf-lib + pdfjs interaction
  // where appending draw ops to a copied page's content stream can leave
  // pdfjs unable to render the appended ops (graphics-state / clipping
  // leftovers from the source). Desktop readers tolerate that; pdfjs
  // doesn't. With embedded pages, our stamps are top-level operators on
  // a clean page so every renderer agrees.
  // Envelope-wide caps (seal-limits.ts): the documents' summed seal cost is
  // bounded as at upload and send, checked before each document is copied.
  assertEnvelopeItemCount(env.items.length);
  const itemCosts: PdfSealCost[] = [];
  for (const item of env.items) {
    const sourceBytes = await readPdfFromStorage(item.documentFile.storagePath);
    // ignoreEncryption=true is defense-in-depth — uploads decrypted via
    // qpdf at storage time, so this should never trip in practice now.
    // Decode limits are re-applied here (not only at upload) because a file
    // stored before they existed, or one that slipped past, must still fail
    // cleanly rather than inflate without bound in a signer's request.
    const source = await loadPdfWithDecodeLimits(sourceBytes, { ignoreEncryption: true });
    // Form flattening and the page copy below are capped (seal-limits.ts) by
    // the same ceilings the upload was checked against.
    await flattenPdfFormAppearances(source);
    itemCosts.push(assertSealCost(source));
    assertEnvelopeSealCost(itemCosts);
    const itemFields = env.fields.filter((f) => f.envelopeItemId === item.id);

    // One embed pass per document, so resources shared between its pages are
    // copied into the sealed output once, not once per page. Embedding decodes
    // each source page's /Contents, under this document's own decode budget.
    // Field coordinates refer to PDF.js's displayed crop and rotation.
    const pages = await withPdfDecodeBudget(() => appendUprightPages(out, source.getPages()));
    for (const [i, page] of pages.entries()) {
      const pageNumber = i + 1; // 1-indexed within the source item
      const fieldsOnPage = itemFields.filter((f) => f.page === pageNumber);
      for (const field of fieldsOnPage) {
        await stampField({
          doc: out,
          page,
          field,
          recipients: env.recipients,
          fieldsById,
          font: helv,
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
  drawAuditPage(out.addPage(), sealedEnv, helv, helvBold);

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

  // Build + sign the manifest, embed as a PDF attachment.
  const manifest = await buildManifest(sealedEnv, orgKey, sealedContent);
  const manifestSha = await sha256Hex(canonicalJson({ ...manifest, manifestSha256: undefined, manifestSignature: undefined }));
  const manifestSignature = await signHex(env.orgId, manifestSha);
  const signedManifest = { ...manifest, manifestSha256: manifestSha, manifestSignature };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(signedManifest));
  await out.attach(manifestBytes, 'docuridge-manifest.json', {
    mimeType: 'application/json',
    description: 'DocuRidge cryptographic manifest',
    creationDate: new Date(),
    modificationDate: new Date(),
  });

  const bytes = Buffer.from(await out.save({ useObjectStreams: false }));
  return {
    envelopeId: env.id,
    orgId: env.orgId,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    manifest: signedManifest,
    manifestSignature,
    chainHeadHash: auditEvents[auditEvents.length - 1]?.eventHash ?? '0'.repeat(64),
    completionEvent,
    signedByKeyId: orgKey.keyId,
    sourceDocumentCount: env.items.length,
    recipients: manifest.recipients,
  };
}

/**
 * - `sealed`: this call stored the file, the SealedDocument row and the
 *   `envelope.sealed` event.
 * - `already_sealed`: an earlier or concurrent attempt got there first; this
 *   one stored nothing.
 * - `not_completed`: the envelope is not COMPLETED; nothing was stored.
 */
export type SealPersistOutcome = 'sealed' | 'already_sealed' | 'not_completed';

/**
 * Store a sealed build: the file, its DocumentFile + SealedDocument rows and
 * the `envelope.sealed` event, only for a COMPLETED envelope that has no
 * sealed document yet.
 *
 * Idempotent and safe under concurrency: the transaction takes the envelope's
 * row lock and re-checks for a SealedDocument under it, so of any number of
 * attempts exactly one stores rows and an event and the rest return
 * `already_sealed` (the unique envelopeId on SealedDocument backs this up).
 * The PDF is staged under a unique name first and moved into place only by
 * the attempt holding the lock, so a losing attempt never overwrites the file
 * a committed row describes.
 *
 * `collect` defers the `envelope.sealed` webhook (see commitWithEnvelopeEvents).
 */
export async function persistSealedEnvelope(
  build: SealedBuild,
  options: { collect?: AppendedEnvelopeEvent[] } = {},
): Promise<SealPersistOutcome> {
  const staged = await stageSealedPdf({
    orgId: build.orgId,
    envelopeId: build.envelopeId,
    buffer: build.bytes,
  });
  try {
    const outcome = await commitWithEnvelopeEvents(build.envelopeId, async (tx, record) => {
      const { count } = await tx.envelope.updateMany({
        where: { id: build.envelopeId, status: 'COMPLETED' },
        data: { updatedAt: new Date() },
      });
      if (count === 0) return 'not_completed' as const;
      const existing = await tx.sealedDocument.findUnique({
        where: { envelopeId: build.envelopeId },
        select: { id: true },
      });
      if (existing) return 'already_sealed' as const;

      const sealedFile = await tx.documentFile.create({
        data: {
          orgId: build.orgId,
          storageType: 'LOCAL_FS',
          storagePath: staged.relativePath,
          mimeType: 'application/pdf',
          sizeBytes: staged.sizeBytes,
          sha256: staged.sha256,
          uploadedById: null,
          scanStatus: 'CLEAN',
          scannedAt: new Date(),
        },
      });
      await tx.sealedDocument.create({
        data: {
          envelopeId: build.envelopeId,
          documentFileId: sealedFile.id,
          manifestJson: build.manifest as Prisma.InputJsonValue,
          manifestSignature: build.manifestSignature,
          chainHeadHash: build.chainHeadHash,
          signedByKeyId: build.signedByKeyId,
        },
      });
      await record({
        envelopeId: build.envelopeId,
        type: 'envelope.sealed',
        data: {
          sha256: staged.sha256,
          sizeBytes: staged.sizeBytes,
          sourceDocumentCount: build.sourceDocumentCount,
        },
      });
      // Last, under the lock: if a write above fails, nothing moved; if the
      // commit fails after this, no row describes the file and the next
      // attempt replaces it.
      await staged.commit();
      return 'sealed' as const;
    }, options);
    if (outcome === 'sealed') {
      log.info(
        { envelopeId: build.envelopeId, sha256: staged.sha256, items: build.sourceDocumentCount, keyId: build.signedByKeyId },
        'envelope sealed and signed',
      );
    }
    return outcome;
  } finally {
    await staged.discard();
  }
}

async function stampField(args: {
  doc: PDFDocument;
  page: PDFPage;
  field: {
    type: string;
    x: { toString(): string } | number;
    y: { toString(): string } | number;
    w: { toString(): string } | number;
    h: { toString(): string } | number;
    value: string | null;
    recipientId: string;
    /** JSON meta — used by NOTE (text), STAMP (image), and others. */
    meta?: unknown;
  };
  recipients: { id: string; name: string; email: string; signatures: { imagePngBase64: string | null; typedSignature: string | null; fieldId: string | null }[] }[];
  /**
   * All fields on the envelope, keyed by id. Used to resolve which Signature
   * row goes with each field — one row anchored to a SIGNATURE field is the
   * adopted full signature, one anchored to an INITIALS field is the adopted
   * initials. Both belong to the same recipient but stamp different marks.
   */
  fieldsById: Record<string, { type: string }>;
  font: PDFFont;
}): Promise<void> {
  const { doc, page, field, recipients, fieldsById, font } = args;
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
  const box = uiToPdf(
    {
      x: Number(field.x.toString()),
      y: Number(field.y.toString()),
      w: Number(field.w.toString()),
      h: Number(field.h.toString()),
    },
    pw,
    ph,
  );

  switch (field.type) {
    case 'SIGNATURE':
    case 'INITIALS': {
      if (signature?.imagePngBase64) {
        try {
          const img = await embedStoredImage(doc, signature.imagePngBase64, ['png']);
          const scaled = img.scaleToFit(box.width, box.height);
          page.drawImage(img, {
            x: box.x + (box.width - scaled.width) / 2,
            y: box.y + (box.height - scaled.height) / 2,
            width: scaled.width,
            height: scaled.height,
          });
          return;
        } catch (err) {
          // A completed, sealed document with a blank signature box is a
          // correctness failure, not a cosmetic one — log at error level so it
          // is visible without reading warn-level noise.
          log.error(
            {
              err: err instanceof Error ? err.message : String(err),
              recipientId: field.recipientId,
              fieldType: field.type,
            },
            'signature image embed failed; falling back to typed signature',
          );
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
      const meta = (field as { meta?: { noteText?: string } }).meta;
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
        const img = await embedStoredImage(doc, b64, ['png']);
        const scaled = img.scaleToFit(box.width, box.height);
        page.drawImage(img, {
          x: box.x + (box.width - scaled.width) / 2,
          y: box.y + (box.height - scaled.height) / 2,
          width: scaled.width,
          height: scaled.height,
        });
      } catch (err) {
        // A completed, sealed document with an empty DRAWING box is a
        // correctness failure, not a cosmetic one — error level so it is
        // visible without reading warn-level noise.
        log.error(
          {
            err: err instanceof Error ? err.message : String(err),
            recipientId: field.recipientId,
            fieldType: field.type,
          },
          'drawing image embed failed; field left blank',
        );
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
        const img = await embedStoredImage(doc, meta.stampImageBase64, ['png', 'jpeg']);
        const scaled = img.scaleToFit(box.width, box.height);
        page.drawImage(img, {
          x: box.x + (box.width - scaled.width) / 2,
          y: box.y + (box.height - scaled.height) / 2,
          width: scaled.width,
          height: scaled.height,
        });
      } catch (err) {
        // Same reasoning as the DRAWING case above: a blank sender stamp on a
        // completed document is a correctness failure.
        log.error(
          {
            err: err instanceof Error ? err.message : String(err),
            recipientId: field.recipientId,
            fieldType: field.type,
          },
          'stamp image embed failed; field left blank',
        );
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

function drawAuditPage(
  page: PDFPage,
  env: any,
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
  for (const it of env.items) {
    page.drawText(winAnsiSafe(`- ${it.title}  sha256:${it.documentFile.sha256.slice(0, 12)}...`), {
      x: 50, y: cursor, size: 9, font: helv, color: rgb(0.1, 0.1, 0.1),
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
  const attachmentRows = (env as { fields?: Array<{ id: string; type: string; recipient?: { name?: string }; attachment?: { filename: string; sha256: string; sizeBytes: number } }> }).fields
    ?.filter((f) => f.type === 'ATTACHMENT' && f.attachment) ?? [];
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

async function buildManifest(env: any, orgKey: { keyId: string; fingerprint: string; publicKeyPem: string; algorithm: string }, sealedContent: SealedContentDigest) {
  const head = env.auditEvents[env.auditEvents.length - 1];
  const sourceHashes = env.items.map((it: any) => ({
    itemOrder: it.order,
    title: it.title,
    sourceSha256: it.documentFile.sha256,
    pageCount: it.pageCount,
  }));
  const recipientSummaries: SealedRecipient[] = env.recipients.map((r: any) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.recipientRole,
    signingOrder: r.signingOrder,
    signingStatus: r.signingStatus,
    signedAt: r.signedAt?.toISOString() ?? null,
  }));
  const events = env.auditEvents.map((e: any) => ({
    seq: e.seq,
    type: e.type,
    createdAt: e.createdAt.toISOString(),
    actor: { userId: e.actorUserId, recipientId: e.actorRecipientId, email: e.actorEmail, name: e.actorName },
    ipAddress: e.ipAddress,
    userAgent: e.userAgent,
    data: e.data,
    prevHash: e.prevHash,
    eventHash: e.eventHash,
    signature: e.signature,
    signedByKeyId: e.signedByKeyId,
  }));
  return {
    // 3: sealedContent carries digestVersion (see content-digest.ts).
    version: 3,
    generator: 'DocuRidge',
    envelope: {
      id: env.id,
      orgId: env.orgId,
      title: env.title,
      sentAt: env.sentAt?.toISOString() ?? null,
      completedAt: env.completedAt?.toISOString() ?? null,
    },
    signedBy: {
      keyId: orgKey.keyId,
      fingerprint: orgKey.fingerprint,
      algorithm: orgKey.algorithm,
      publicKeyPem: orgKey.publicKeyPem,
    },
    documents: sourceHashes,
    sealedContent,
    recipients: recipientSummaries,
    auditChain: {
      head: head?.eventHash ?? null,
      length: env.auditEvents.length,
      events,
    },
  };
}
