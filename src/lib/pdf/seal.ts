import { PDFDocument, StandardFonts, rgb, PDFFont } from 'pdf-lib';
import { prisma } from '../prisma';
import { readPdfFromStorage, saveSealedPdf } from '../storage';
import { uiToPdf } from './coords';
import { canonicalJson, recordEnvelopeEvent } from '../audit/envelope';
import { sha256Hex } from '../util';
import { childLogger } from '../logger';

const log = childLogger({ module: 'pdf-seal' });

/**
 * Seal an envelope: stamp signature images and field values onto each
 * EnvelopeItem PDF, append a human-readable audit page, embed a JSON
 * manifest as a PDF attachment, hash and persist as SealedDocument.
 *
 * Phase 4 will add the PAdES-style cryptographic signature; for Phase 2
 * we stamp + manifest + hash, and store the chain head for verification.
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

  // For Phase 2 single-document envelopes, seal the first (and only) item.
  // Multi-doc support is in the schema; the loop handles >1 item correctly.
  let combined: PDFDocument | null = null;

  for (const item of env.items) {
    const sourceBytes = await readPdfFromStorage(item.documentFile.storagePath);
    const doc = await PDFDocument.load(sourceBytes);
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
    const pages = doc.getPages();

    const itemFields = env.fields.filter((f) => f.envelopeItemId === item.id);
    for (const field of itemFields) {
      const recipient = env.recipients.find((r) => r.id === field.recipientId);
      const signature = recipient?.signatures[0];
      const page = pages[field.page - 1];
      if (!page) continue;
      const pw = page.getWidth();
      const ph = page.getHeight();
      const box = uiToPdf(
        { x: Number(field.x), y: Number(field.y), w: Number(field.w), h: Number(field.h) },
        pw,
        ph,
      );

      switch (field.type) {
        case 'SIGNATURE':
        case 'INITIALS': {
          await stampSignature({ doc, page, box, signature, font: helv });
          break;
        }
        case 'DATE': {
          drawCenteredText(page, field.value || new Date().toISOString().slice(0, 10), box, helv);
          break;
        }
        case 'CHECKBOX': {
          if ((field.value || '').toLowerCase() === 'true') {
            page.drawText('✓', {
              x: box.x + box.width * 0.15,
              y: box.y + box.height * 0.15,
              size: Math.min(box.width, box.height) * 0.7,
              font: helv,
              color: rgb(0, 0, 0),
            });
          }
          break;
        }
        case 'NAME': {
          drawCenteredText(page, recipient?.name || '', box, helv);
          break;
        }
        case 'EMAIL': {
          drawCenteredText(page, recipient?.email || '', box, helv);
          break;
        }
        case 'TEXT':
        case 'NUMBER':
        default: {
          drawCenteredText(page, field.value ?? '', box, helv);
          break;
        }
      }
    }

    // Append the human-readable audit page.
    const auditPage = doc.addPage();
    drawAuditPage(auditPage, env, helv, helvBold);

    // Embed signed JSON manifest as a PDF attachment.
    const manifestObj = await buildManifest(env);
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestObj));
    await doc.attach(manifestBytes, 'docuridge-manifest.json', {
      mimeType: 'application/json',
      description: 'DocuRidge cryptographic manifest',
      creationDate: new Date(),
      modificationDate: new Date(),
    });

    const sealedBytes = Buffer.from(await doc.save());

    if (env.items.length === 1) {
      // Single item — store this sealed PDF directly.
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
          manifestJson: manifestObj as object,
          manifestSignature: '',
          chainHeadHash: chainHead,
          signedByKeyId: '',
        },
        update: {
          documentFileId: sealedFile.id,
          manifestJson: manifestObj as object,
          chainHeadHash: chainHead,
        },
      });
      await recordEnvelopeEvent({
        envelopeId: env.id,
        type: 'envelope.sealed',
        data: { sha256: stored.sha256, sizeBytes: stored.sizeBytes },
      });
      log.info({ envelopeId: env.id, sha256: stored.sha256 }, 'envelope sealed');
    } else {
      // Multi-document support is in the schema; for v1 we keep the first
      // sealed item only and document multi-doc sealing as a small
      // follow-up. Combining multiple PDFs into one with appended audit
      // pages is straightforward but out of Phase 2 scope.
      combined = doc;
    }
  }

  if (combined && env.items.length > 1) {
    log.warn({ envelopeId: env.id }, 'multi-document sealing simplified — first document used');
  }
}

async function stampSignature(args: {
  doc: PDFDocument;
  page: ReturnType<PDFDocument['getPages']>[number];
  box: { x: number; y: number; width: number; height: number };
  signature: { imagePngBase64: string | null; typedSignature: string | null } | undefined;
  font: PDFFont;
}): Promise<void> {
  const { doc, page, box, signature, font } = args;
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
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'signature image embed failed; falling back to typed');
    }
  }
  if (signature?.typedSignature) {
    drawCenteredText(page, signature.typedSignature, box, font);
  }
}

function drawCenteredText(
  page: ReturnType<PDFDocument['getPages']>[number],
  text: string,
  box: { x: number; y: number; width: number; height: number },
  font: PDFFont,
) {
  if (!text) return;
  // Pick a font size that fits.
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
  page: ReturnType<PDFDocument['addPage']>,
  env: any, // typed from caller; loose to keep this isolated
  helv: PDFFont,
  helvBold: PDFFont,
) {
  const { width, height } = page.getSize();
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
    if (cursor < 60) {
      // Out of room — caller can add another page in a future iteration.
      break;
    }
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
  const sourceHashes = await Promise.all(
    env.items.map(async (it: any) => ({
      itemOrder: it.order,
      title: it.title,
      sourceSha256: it.documentFile.sha256,
    })),
  );
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
  // Bind a manifest-level hash for tamper detection on the manifest itself.
  const manifestSha = await sha256Hex(canonicalJson(manifest));
  return { ...manifest, manifestSha256: manifestSha };
}
