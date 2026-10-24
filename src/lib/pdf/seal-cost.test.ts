import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

const mocks = vi.hoisted(() => ({
  envelopeFind: vi.fn(),
  sources: new Map<string, Buffer>(),
  sealed: vi.fn(),
}));
vi.mock('../prisma', () => ({ prisma: {
  envelope: { findUnique: mocks.envelopeFind },
  documentFile: { create: async () => ({ id: 'sealed-file' }) },
  sealedDocument: { upsert: async () => ({}) },
} }));
vi.mock('../storage', () => ({
  readPdfFromStorage: async (path: string) => mocks.sources.get(path)!,
  saveSealedPdf: async (args: { buffer: Buffer }) => {
    mocks.sealed(args.buffer);
    return { relativePath: 'sealed.pdf', sizeBytes: args.buffer.length, sha256: 'f'.repeat(64) };
  },
}));
vi.mock('../crypto/org-key', () => ({
  getOrCreateOrgKey: async () => ({ keyId: 'key', fingerprint: 'fp', publicKeyPem: 'pem', algorithm: 'ed25519' }),
  signHex: async () => 'sig',
}));
vi.mock('../audit/envelope', async () => ({
  canonicalJson: (await import('../audit/canonical')).canonicalJson,
  recordEnvelopeEvent: vi.fn(),
}));

import { sealEnvelope } from './seal';
import { PdfComplexityError } from './seal-limits';
import { sharedAnnotsPdf, sharedKidsFormPdf } from './__fixtures__/hostile-form-pdf';

function envelopeWith(paths: string[]) {
  return {
    id: 'env', orgId: 'org', title: 'Envelope', sentAt: null, completedAt: null,
    org: { name: 'Org' }, createdBy: { name: 'Sender', email: 'sender@example.com' },
    items: paths.map((path, order) => ({
      id: `item-${order}`, order, title: path, pageCount: 1,
      documentFile: { storagePath: path, sha256: 'a'.repeat(64) },
    })),
    recipients: [], fields: [], auditEvents: [],
  };
}

async function sealOne(bytes: Buffer): Promise<unknown> {
  mocks.sources.set('doc.pdf', bytes);
  mocks.envelopeFind.mockResolvedValue(envelopeWith(['doc.pdf']));
  return sealEnvelope({ envelopeId: 'env' }).then(() => undefined, (e: unknown) => e);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sources.clear();
});

describe('sealEnvelope form flattening caps', () => {
  it.each([
    ['shared /Kids (2^24 field paths)', () => sharedKidsFormPdf(24), 'form_shape'],
    ['500 pages sharing one 50-entry /Annots array', () => sharedAnnotsPdf(500, 50), 'annotations'],
  ] as const)('fails cleanly, in bounded time, on %s', async (_name, build, limit) => {
    const bytes = await build();
    const started = Date.now();
    const err = await sealOne(bytes);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(err).toBeInstanceOf(PdfComplexityError);
    expect((err as PdfComplexityError).limit).toBe(limit);
    expect(mocks.sealed).not.toHaveBeenCalled();
  });

  it('still seals an ordinary form-bearing PDF', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const field = doc.getForm().createTextField('name');
    field.setText('Jane Signer');
    field.addToPage(page, { x: 50, y: 600, width: 200, height: 24 });
    expect(await sealOne(Buffer.from(await doc.save()))).toBeUndefined();
    expect(mocks.sealed).toHaveBeenCalledTimes(1);
  });
});
