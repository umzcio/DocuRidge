import { PDFDocument, StandardFonts, PDFFont, PDFPage, rgb } from 'pdf-lib';
import { winAnsiSafe } from './pdf/winansi';

/**
 * Completion package — human-readable "Certificate of Completion" PDF.
 *
 * One page (Letter) carrying the envelope metadata, a per-recipient
 * completion table (name, email, signed/declined timestamp, IP), the
 * envelope's audit-chain head digest, and a "How to verify" box. The
 * certificate references the same tamper-evident audit chain that backs the
 * sealed PDF and the audit JSON export, so counsel gets a records-ready
 * artifact that points at independently verifiable evidence.
 *
 * Rendering patterns (Helvetica/HelveticaBold, cursor-based layout, the
 * winAnsiSafe sanitizer from src/lib/pdf/winansi.ts) intentionally mirror the
 * seal's audit page so the two artifacts look like siblings.
 */

export interface CompletionCertificateRecipient {
  name: string;
  email: string;
  signedAt: Date | null;
  declinedAt: Date | null;
  ipAddress: string | null;
}

export interface CompletionCertificateInput {
  envelopeTitle: string;
  completedAt: Date;
  senderName: string;
  recipients: CompletionCertificateRecipient[];
  /** Head (latest eventHash) of the envelope's signed audit chain. */
  auditChainHash: string;
  /** Verification instructions shown in the "How to verify" box. */
  verifyInstructions: string;
}

const INK = rgb(0.1, 0.1, 0.1);
const INK_SOFT = rgb(0.3, 0.3, 0.3);
const HEADER = rgb(0.1, 0.2, 0.25);
const RULE = rgb(0.8, 0.8, 0.8);

export async function buildCompletionCertificate(
  input: CompletionCertificateInput,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Certificate of Completion - ${input.envelopeTitle}`);
  doc.setProducer('DocuRidge');

  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const page = doc.addPage([612, 792]); // US Letter
  const { height } = page.getSize();
  const M = 50; // margin
  let cursor = height - M;

  page.drawText('Certificate of Completion', {
    x: M,
    y: cursor - 14,
    size: 20,
    font: helvBold,
    color: HEADER,
  });
  cursor -= 22;
  page.drawLine({
    start: { x: M, y: cursor },
    end: { x: 612 - M, y: cursor },
    thickness: 1,
    color: RULE,
  });
  cursor -= 16;

  cursor = drawWrapped(page,
    'This certificate confirms that the electronic signing ceremony recorded below was completed via DocuRidge. Every event is protected by a tamper-evident, signed audit chain.',
    { x: M, y: cursor, maxWidth: 612 - M * 2, font: helv, size: 9.5, color: INK_SOFT },
  );
  cursor -= 10;

  // Envelope metadata block — label/value pairs, labels in bold.
  cursor = drawMetaRow(page, 'Envelope', input.envelopeTitle, M, cursor, helvBold, helv);
  cursor = drawMetaRow(
    page,
    'Completed at',
    input.completedAt.toUTCString(),
    M,
    cursor,
    helvBold,
    helv,
  );
  cursor = drawMetaRow(page, 'Sent by', input.senderName, M, cursor, helvBold, helv);
  cursor -= 10;

  // Recipient table.
  page.drawText('Recipients', { x: M, y: cursor - 10, size: 12, font: helvBold, color: INK });
  cursor -= 26;
  const col = { name: M, email: 205, outcome: 385, ip: 520 };
  page.drawText('Name', { x: col.name, y: cursor, size: 8, font: helvBold, color: INK_SOFT });
  page.drawText('Email', { x: col.email, y: cursor, size: 8, font: helvBold, color: INK_SOFT });
  page.drawText('Completed / declined', { x: col.outcome, y: cursor, size: 8, font: helvBold, color: INK_SOFT });
  page.drawText('IP address', { x: col.ip, y: cursor, size: 8, font: helvBold, color: INK_SOFT });
  cursor -= 4;
  page.drawLine({
    start: { x: M, y: cursor },
    end: { x: 612 - M, y: cursor },
    thickness: 0.7,
    color: RULE,
  });
  cursor -= 12;

  const BOTTOM_GUARD = 170; // leave room for digest + verify box below the table
  for (const r of input.recipients) {
    if (cursor < BOTTOM_GUARD) break;
    const outcome = r.signedAt
      ? `Signed ${r.signedAt.toUTCString()}`
      : r.declinedAt
        ? `Declined ${r.declinedAt.toUTCString()}`
        : '—';
    const outcomeSize = fitSize(helv, winAnsiSafe(outcome, helv), col.ip - col.outcome - 6, 8);
    const ipSize = fitSize(helv, winAnsiSafe(r.ipAddress ?? '—', helv), 612 - M - col.ip, 8);
    page.drawText(winAnsiSafe(r.name, helv), { x: col.name, y: cursor, size: 9, font: helv, color: INK });
    page.drawText(winAnsiSafe(r.email, helv), { x: col.email, y: cursor, size: 9, font: helv, color: INK });
    page.drawText(winAnsiSafe(outcome, helv), { x: col.outcome, y: cursor, size: outcomeSize, font: helv, color: INK });
    page.drawText(winAnsiSafe(r.ipAddress ?? '—', helv), { x: col.ip, y: cursor, size: ipSize, font: helv, color: INK });
    cursor -= 14;
  }
  cursor -= 8;

  // Audit chain digest — proves which chain this certificate describes.
  if (input.auditChainHash) {
    page.drawText('Audit chain digest (SHA-256 head)', {
      x: M,
      y: cursor - 8,
      size: 10,
      font: helvBold,
      color: INK,
    });
    cursor -= 22;
    page.drawText(winAnsiSafe(input.auditChainHash, helv), {
      x: M,
      y: cursor,
      size: 8,
      font: helv,
      color: INK_SOFT,
    });
    cursor -= 14;
  }

  // "How to verify" box — bottom-anchored at a fixed position. The recipient
  // guard above guarantees the table never descends into it, so the box sits
  // at the same place on every certificate.
  const BOX_HEIGHT = 64;
  const boxTop = 118;
  page.drawRectangle({
    x: M,
    y: boxTop - BOX_HEIGHT,
    width: 612 - M * 2,
    height: BOX_HEIGHT,
    borderColor: RULE,
    borderWidth: 0.8,
  });
  page.drawText('How to verify', {
    x: M + 10,
    y: boxTop - 16,
    size: 9,
    font: helvBold,
    color: INK,
  });
  drawWrapped(page, input.verifyInstructions, {
    x: M + 10,
    y: boxTop - 28,
    maxWidth: 612 - M * 2 - 20,
    font: helv,
    size: 8.5,
    color: INK_SOFT,
  });

  page.drawText(`Generated by DocuRidge at ${new Date().toUTCString()}`, {
    x: M,
    y: M - 20,
    size: 7.5,
    font: helv,
    color: INK_SOFT,
  });

  return doc.save();
}

/** Shrink a font size (bounded) until `text` fits `maxWidth`, seal.ts-style. */
function fitSize(font: PDFFont, text: string, maxWidth: number, base: number): number {
  let size = base;
  for (let i = 0; i < 6 && font.widthOfTextAtSize(text, size) > maxWidth; i++) {
    size *= 0.85;
  }
  return size;
}

function drawMetaRow(
  page: PDFPage,
  label: string,
  value: string,
  x: number,
  yTop: number,
  bold: PDFFont,
  regular: PDFFont,
): number {
  const size = 10;
  const labelText = winAnsiSafe(`${label}:`, bold);
  page.drawText(labelText, { x, y: yTop - size, size, font: bold, color: INK });
  const labelWidth = bold.widthOfTextAtSize(labelText, size);
  return drawWrapped(page, value, {
    x: x + labelWidth + 8,
    y: yTop,
    maxWidth: 612 - 50 - (x + labelWidth + 8),
    font: regular,
    size,
    color: INK,
  });
}

/** Draw text top-down, wrapping on word boundaries. Returns the y below the last line. */
function drawWrapped(
  page: PDFPage,
  text: string,
  opts: {
    x: number;
    y: number; // top of the first line
    maxWidth: number;
    font: PDFFont;
    size: number;
    color: ReturnType<typeof rgb>;
  },
): number {
  const words = text.split(/\s+/).map((word) => winAnsiSafe(word, opts.font)).filter(Boolean);
  if (words.length === 0) return opts.y - opts.size;
  const lineHeight = opts.size * 1.35;
  let line = '';
  let y = opts.y - opts.size;
  const flush = () => {
    page.drawText(line, {
      x: opts.x,
      y,
      size: opts.size,
      font: opts.font,
      color: opts.color,
    });
    y -= lineHeight;
    line = '';
  };
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (opts.font.widthOfTextAtSize(candidate, opts.size) > opts.maxWidth && line) {
      flush();
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) flush();
  return y + lineHeight - opts.size;
}
