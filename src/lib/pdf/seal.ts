import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from 'pdf-lib';
import { prisma } from '../prisma';
import { readPdfFromStorage, saveSealedPdf } from '../storage';
import { uiToPdf } from './coords';
import { canonicalJson, recordEnvelopeEvent } from '../audit/envelope';
import { sha256Hex } from '../util';
import { childLogger } from '../logger';
import { getOrCreateOrgKey, signHex } from '../crypto/org-key';

const log = childLogger({ module: 'pdf-seal' });

/**
 * Seal an envelope.
 *
 *   - For multi-document envelopes, copies each source PDF's pages into a
 *     single output PDF in the order the user uploaded them, stamps fields
 *     onto each, then appends a human-readable audit page and embeds a
 *     signed JSON manifest as a PDF attachment.
 *   - Document hashes (source SHA-256 of each input file) are recorded in
 *     the manifest, plus the chain head, so a verifier can confirm the seal
 *     bound the exact inputs.
 *   - Phase 4 will add the PAdES-style cryptographic signature and populate
 *     SealedDocument.signedByKeyId / manifestSignature.
 */
export async function sealEnvelope(args: { envelopeId: string }): Promise<void> {
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

  // Page-index → fields targeting that page (after copy into `out`).
  // We process each source item in order, copy its pages, stamp its fields
  // onto the corresponding new pages, then move on.
  for (const item of env.items) {
    const sourceBytes = await readPdfFromStorage(item.documentFile.storagePath);
    const source = await PDFDocument.load(sourceBytes);
    const sourcePageCount = source.getPageCount();
    const indices = Array.from({ length: sourcePageCount }, (_, i) => i);
    const copied = await out.copyPages(source, indices);
    const itemFields = env.fields.filter((f) => f.envelopeItemId === item.id);

    for (let i = 0; i < copied.length; i++) {
      const page = copied[i]!;
      out.addPage(page);
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
  }

  // Append the human-readable audit page.
  drawAuditPage(out.addPage(), env, helv, helvBold);

  // Build + sign the manifest, embed as a PDF attachment.
  const orgKey = await getOrCreateOrgKey(env.orgId);
  const manifest = await buildManifest(env, orgKey);
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

  const sealedBytes = Buffer.from(await out.save());
  const stored = await saveSealedPdf({
    orgId: env.orgId,
    envelopeId: env.id,
    buffer: sealedBytes,
  });
  const sealedFile = await prisma.documentFile.create({
    data: {
      orgId: env.orgId,
      storageType: 'LOCAL_FS',
      storagePath: stored.relativePath,
      mimeType: 'application/pdf',
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      uploadedById: null,
      scanStatus: 'CLEAN',
      scannedAt: new Date(),
    },
  });

  const chainHead = env.auditEvents[env.auditEvents.length - 1]?.eventHash ?? '0'.repeat(64);
  await prisma.sealedDocument.upsert({
    where: { envelopeId: env.id },
    create: {
      envelopeId: env.id,
      documentFileId: sealedFile.id,
      manifestJson: signedManifest as object,
      manifestSignature,
      chainHeadHash: chainHead,
      signedByKeyId: orgKey.keyId,
    },
    update: {
      documentFileId: sealedFile.id,
      manifestJson: signedManifest as object,
      manifestSignature,
      chainHeadHash: chainHead,
      signedByKeyId: orgKey.keyId,
    },
  });
  await recordEnvelopeEvent({
    envelopeId: env.id,
    type: 'envelope.sealed',
    data: {
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
      sourceDocumentCount: env.items.length,
    },
  });
  log.info(
    { envelopeId: env.id, sha256: stored.sha256, items: env.items.length, keyId: orgKey.keyId },
    'envelope sealed and signed',
  );
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
          const img = await doc.embedPng(Buffer.from(signature.imagePngBase64, 'base64'));
          const scaled = img.scaleToFit(box.width, box.height);
          page.drawImage(img, {
            x: box.x + (box.width - scaled.width) / 2,
            y: box.y + (box.height - scaled.height) / 2,
            width: scaled.width,
            height: scaled.height,
          });
          return;
        } catch (err) {
          log.warn({ err: err instanceof Error ? err.message : String(err) }, 'signature image embed failed; fallback to typed');
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
      // field.value. Embed as PNG (the ceremony always exports PNG) and
      // scale-to-fit the placed field box.
      const v = field.value ?? '';
      if (!v) return;
      const m = v.match(/^data:image\/(?:png|jpeg);base64,(.+)$/);
      const b64 = m ? m[1]! : v;
      try {
        const buf = Buffer.from(b64, 'base64');
        const img = await doc.embedPng(buf);
        const scaled = img.scaleToFit(box.width, box.height);
        page.drawImage(img, {
          x: box.x + (box.width - scaled.width) / 2,
          y: box.y + (box.height - scaled.height) / 2,
          width: scaled.width,
          height: scaled.height,
        });
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'drawing image embed failed; skipping',
        );
      }
      return;
    }
    case 'STAMP': {
      // Sender-uploaded image embedded once into the doc. Picks PNG vs JPEG
      // embed based on the stored MIME; WebP is rejected at upload time so
      // we don't have to handle it here.
      const meta = (field.meta && typeof field.meta === 'object'
        ? field.meta as { stampImageBase64?: string; stampMimeType?: string }
        : {});
      if (!meta.stampImageBase64) return;
      try {
        const buf = Buffer.from(meta.stampImageBase64, 'base64');
        const img = meta.stampMimeType === 'image/jpeg'
          ? await doc.embedJpg(buf)
          : await doc.embedPng(buf);
        const scaled = img.scaleToFit(box.width, box.height);
        page.drawImage(img, {
          x: box.x + (box.width - scaled.width) / 2,
          y: box.y + (box.height - scaled.height) / 2,
          width: scaled.width,
          height: scaled.height,
        });
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'stamp image embed failed; skipping',
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

async function buildManifest(env: any, orgKey: { keyId: string; fingerprint: string; publicKeyPem: string; algorithm: string }) {
  const head = env.auditEvents[env.auditEvents.length - 1];
  const sourceHashes = env.items.map((it: any) => ({
    itemOrder: it.order,
    title: it.title,
    sourceSha256: it.documentFile.sha256,
    pageCount: it.pageCount,
  }));
  const recipientSummaries = env.recipients.map((r: any) => ({
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
    version: 1,
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
    recipients: recipientSummaries,
    auditChain: {
      head: head?.eventHash ?? null,
      length: env.auditEvents.length,
      events,
    },
  };
}
