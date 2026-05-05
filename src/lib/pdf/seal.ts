import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from 'pdf-lib';
import { prisma } from '../prisma';
import { readPdfFromStorage, saveSealedPdf } from '../storage';
import { uiToPdf } from './coords';
import { canonicalJson, recordEnvelopeEvent } from '../audit/envelope';
import { sha256Hex } from '../util';
import { childLogger } from '../logger';

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
      fields: true,
      auditEvents: { orderBy: { seq: 'asc' } },
    },
  });
  if (!env) throw new Error('Envelope not found for sealing');

  const out = await PDFDocument.create();
  const helv = await out.embedFont(StandardFonts.Helvetica);
  const helvBold = await out.embedFont(StandardFonts.HelveticaBold);

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
          font: helv,
        });
      }
    }
  }

  // Append the human-readable audit page.
  drawAuditPage(out.addPage(), env, helv, helvBold);

  // Embed signed JSON manifest as a PDF attachment.
  const manifest = await buildManifest(env);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
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
      manifestJson: manifest as object,
      manifestSignature: '',
      chainHeadHash: chainHead,
      signedByKeyId: '',
    },
    update: {
      documentFileId: sealedFile.id,
      manifestJson: manifest as object,
      chainHeadHash: chainHead,
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
    { envelopeId: env.id, sha256: stored.sha256, items: env.items.length },
    'envelope sealed',
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
  };
  recipients: { id: string; name: string; email: string; signatures: { imagePngBase64: string | null; typedSignature: string | null }[] }[];
  font: PDFFont;
}): Promise<void> {
  const { doc, page, field, recipients, font } = args;
  const recipient = recipients.find((r) => r.id === field.recipientId);
  const signature = recipient?.signatures[0];
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
        page.drawText('✓', {
          x: box.x + box.width * 0.15,
          y: box.y + box.height * 0.15,
          size: Math.min(box.width, box.height) * 0.7,
          font,
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
    case 'TEXT':
    case 'NUMBER':
    default: {
      drawCenteredText(page, field.value ?? '', box, font);
      return;
    }
  }
}

function drawCenteredText(
  page: PDFPage,
  text: string,
  box: { x: number; y: number; width: number; height: number },
  font: PDFFont,
) {
  if (!text) return;
  let size = Math.min(box.height * 0.7, 14);
  for (let i = 0; i < 6; i++) {
    const w = font.widthOfTextAtSize(text, size);
    if (w <= box.width * 0.95) break;
    size *= 0.85;
  }
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: box.x + (box.width - w) / 2,
    y: box.y + (box.height - size) / 2,
    size,
    font,
    color: rgb(0, 0, 0),
  });
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

  page.drawText(`Envelope: ${env.title}`, { x: 50, y: cursor, size: 11, font: helvBold, color: rgb(0, 0, 0) });
  cursor -= 14;
  page.drawText(`ID: ${env.id}`, { x: 50, y: cursor, size: 9, font: helv, color: rgb(0.3, 0.3, 0.3) });
  cursor -= 12;
  page.drawText(`Sender: ${env.createdBy?.name ?? '(unknown)'} (${env.createdBy?.email ?? '?'})`, {
    x: 50, y: cursor, size: 10, font: helv, color: rgb(0, 0, 0),
  });
  cursor -= 12;
  page.drawText(`Organisation: ${env.org?.name ?? '?'}`, { x: 50, y: cursor, size: 10, font: helv, color: rgb(0, 0, 0) });
  cursor -= 22;

  page.drawText('Documents', { x: 50, y: cursor, size: 12, font: helvBold, color: rgb(0, 0, 0) });
  cursor -= 14;
  for (const it of env.items) {
    page.drawText(`• ${it.title} — sha256:${it.documentFile.sha256.slice(0, 12)}…`, {
      x: 50, y: cursor, size: 9, font: helv, color: rgb(0.1, 0.1, 0.1),
    });
    cursor -= 12;
  }
  cursor -= 8;

  page.drawText('Recipients', { x: 50, y: cursor, size: 12, font: helvBold, color: rgb(0, 0, 0) });
  cursor -= 14;
  for (const r of env.recipients) {
    page.drawText(
      `• ${r.name} <${r.email}> — ${r.signingStatus}${r.signedAt ? ' at ' + new Date(r.signedAt).toUTCString() : ''}`,
      { x: 50, y: cursor, size: 9, font: helv, color: rgb(0.1, 0.1, 0.1) },
    );
    cursor -= 12;
  }
  cursor -= 10;

  page.drawText('Events', { x: 50, y: cursor, size: 12, font: helvBold, color: rgb(0, 0, 0) });
  cursor -= 14;
  for (const e of env.auditEvents) {
    if (cursor < 60) break;
    const ts = new Date(e.createdAt).toISOString();
    const actor = e.actorEmail ?? e.actorName ?? '';
    page.drawText(`${ts}  ${e.type}  ${actor}`, {
      x: 50, y: cursor, size: 8, font: helv, color: rgb(0.1, 0.1, 0.1),
    });
    cursor -= 11;
  }
}

async function buildManifest(env: any) {
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
    actor: { userId: e.actorUserId, recipientId: e.actorRecipientId, email: e.actorEmail },
    prevHash: e.prevHash,
    eventHash: e.eventHash,
  }));
  const manifest = {
    version: 1,
    generator: 'DocuRidge',
    envelope: {
      id: env.id,
      orgId: env.orgId,
      title: env.title,
      sentAt: env.sentAt?.toISOString() ?? null,
      completedAt: env.completedAt?.toISOString() ?? null,
    },
    documents: sourceHashes,
    recipients: recipientSummaries,
    auditChain: {
      head: head?.eventHash ?? null,
      length: env.auditEvents.length,
      events,
    },
  };
  const manifestSha = await sha256Hex(canonicalJson(manifest));
  return { ...manifest, manifestSha256: manifestSha };
}
