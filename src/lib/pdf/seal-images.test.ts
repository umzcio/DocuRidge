import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const mocks = vi.hoisted(() => ({
  envelopeFind: vi.fn(),
  rows: new Map<string, Record<string, unknown> & { id: string }>(),
  uploadsDir: '',
}));
vi.mock('../prisma', async () => {
  const { fakeDocumentFileTable } = await import('../documents/__fixtures__/stored-documents');
  return { prisma: { envelope: { findUnique: mocks.envelopeFind }, documentFile: fakeDocumentFileTable(mocks.rows) } };
});
vi.mock('../env', () => ({ getEnv: () => ({ UPLOADS_DIR: mocks.uploadsDir }) }));
vi.mock('../crypto/org-key', () => ({
  getOrCreateOrgKey: async () => ({ keyId: 'key', fingerprint: 'fp', publicKeyPem: 'pem', algorithm: 'ed25519' }),
  signHex: async () => 'sig',
  signHexWithKey: async () => 'sig',
}));
vi.mock('../audit/envelope', async () => ({
  canonicalJson: (await import('../audit/canonical')).canonicalJson,
  recordEnvelopeEvent: vi.fn(),
  commitWithEnvelopeEvents: vi.fn(),
  prepareEnvelopeEvent: (await vi.importActual<typeof import('../audit/envelope')>('../audit/envelope')).prepareEnvelopeEvent,
}));

import { buildSealedEnvelope } from './seal';
import { PdfComplexityError } from './seal-limits';
import { seedCanonicalDocument } from '../documents/__fixtures__/stored-documents';

mocks.uploadsDir = mkdtempSync(join(tmpdir(), 'docuridge-seal-images-'));
afterAll(() => rmSync(mocks.uploadsDir, { recursive: true, force: true }));

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A valid 8-bit grayscale PNG of `width` x `height`, filled with `shade` (distinct shades give distinct files). */
function grayPng(width: number, height: number, shade: number): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const row = Buffer.alloc(width + 1, shade);
  row[0] = 0;
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) row.copy(raw, y * row.length);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

function envelopeWith(recipients: unknown[], fields: unknown[]) {
  return {
    id: 'env', orgId: 'org', title: 'Envelope', sentAt: null, completedAt: null,
    org: { name: 'Org' }, createdBy: { name: 'Sender', email: 'sender@example.com' },
    items: [{ id: 'item-0', order: 0, title: 'a.pdf', pageCount: 1, documentFileId: 'df1', documentFile: mocks.rows.get('df1') }],
    recipients, fields, auditEvents: [],
  };
}

const recipient = (id: string, image: string) => ({
  id, name: id, email: `${id}@example.com`, signingOrder: 1, signingStatus: 'SIGNED', signedAt: null,
  signatures: [{ imagePngBase64: image, typedSignature: null, fieldId: null }],
});
const signatureField = (id: string, recipientId: string, i = 0) => ({
  id, type: 'SIGNATURE', recipientId, envelopeItemId: 'item-0', page: 1,
  x: (i % 50) / 60, y: Math.floor(i / 50) / 70, w: 0.01, h: 0.01, value: null, meta: null, attachment: null,
  recipient: { name: recipientId, email: `${recipientId}@example.com` },
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  mocks.rows.clear();
  await seedCanonicalDocument(mocks.rows, mocks.uploadsDir, 'df1', await doc.save());
});

describe('buildSealedEnvelope images', () => {
  it('decodes one image once however many fields draw it', async () => {
    const png = grayPng(4096, 2048, 90); // 8 MP
    const fields = Array.from({ length: 3000 }, (_, i) => signatureField(`f${i}`, 'r1', i));
    mocks.envelopeFind.mockResolvedValue(envelopeWith([recipient('r1', png)], fields));
    const embed = vi.spyOn(PDFDocument.prototype, 'embedPng');

    const build = await buildSealedEnvelope({ envelopeId: 'env' });

    expect(embed).toHaveBeenCalledTimes(1);
    const sealed = await PDFDocument.load(build.bytes);
    const images = sealed.context.enumerateIndirectObjects().filter(
      ([, obj]) => obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'),
    );
    expect(images).toHaveLength(1);
  }, 120_000);

  it('refuses distinct images over the pixel budget before embedding anything', async () => {
    const recipients = Array.from({ length: 9 }, (_, i) => recipient(`r${i}`, grayPng(4096, 2048, 10 + i)));
    const fields = recipients.map((r, i) => signatureField(`f${i}`, r.id, i));
    mocks.envelopeFind.mockResolvedValue(envelopeWith(recipients, fields));
    const embed = vi.spyOn(PDFDocument.prototype, 'embedPng');
    const copyPages = vi.spyOn(PDFDocument.prototype, 'copyPages');

    const err = await buildSealedEnvelope({ envelopeId: 'env' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PdfComplexityError);
    expect((err as PdfComplexityError).limit).toBe('seal_image_pixels');
    expect(embed).not.toHaveBeenCalled();
    expect(copyPages).not.toHaveBeenCalled();
  }, 120_000);
});
