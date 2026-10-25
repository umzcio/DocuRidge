import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

const mocks = vi.hoisted(() => ({
  sources: new Map<string, Buffer>(),
  existingFile: {} as Record<string, unknown>,
  existing: [] as Array<{ id: string; order: number; title: string; documentFileId: string }>,
  save: vi.fn(),
  createFile: vi.fn(),
  createItem: vi.fn(),
}));

vi.mock('../prisma', () => ({
  prisma: {
    envelope: {
      findFirst: async () => ({ id: 'env1', orgId: 'org1', createdById: 'u1', status: 'DRAFT' }),
    },
    envelopeItem: {
      findMany: async () => mocks.existing,
      aggregate: async () => ({ _max: { order: mocks.existing.length } }),
      create: mocks.createItem,
    },
    documentFile: { create: mocks.createFile, findUnique: async () => structuredClone(mocks.existingFile) },
  },
}));
vi.mock('../storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../storage')>()),
  saveUploadedPdf: mocks.save,
  scanFile: async () => 'CLEAN',
  readPdfFromStorage: async (path: string) => mocks.sources.get(path)!,
}));
vi.mock('../audit/envelope', () => ({ recordEnvelopeEvent: vi.fn() }));
vi.mock('../pdf-worker/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pdf-worker/runner')>();
  return { ...actual, runPdfJob: vi.fn(actual.runPdfJob) };
});

import { addEnvelopeFile } from './service';
import { UploadValidationError } from '../storage';
import { PdfWorkerError, runPdfJob } from '../pdf-worker/runner';

const ctx = { userId: 'u1', orgId: 'org1', role: 'ADMIN' as const };
const upload = () => addEnvelopeFile({
  ctx, envelopeId: 'env1', buffer: Buffer.from('%PDF-new'), declaredMime: 'application/pdf', filename: 'new.pdf',
});

async function pagesPdf(count: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  // The existing document already has its canonical copy: three pages.
  mocks.existingFile = {
    id: 'df-three', orgId: 'org1', storagePath: 'org1/three.pdf',
    canonicalStoragePath: `org1/canonical/${'d'.repeat(64)}.pdf`, canonicalSha256: 'd'.repeat(64), canonicalVersion: 1,
    canonicalPageCount: 3, canonicalSealCost: { pages: 3, objects: 60, bytes: 200 }, canonicalRefusal: null,
  };
  mocks.existing = [{ id: 'i1', order: 1, title: 'Three.pdf', documentFileId: 'df-three' }];
  mocks.save.mockResolvedValue({
    storagePath: '/data/uploads/org1/new.pdf', relativePath: 'org1/new.pdf', sizeBytes: 8,
    sha256: 'a'.repeat(64), mimeType: 'application/pdf',
    canonical: {
      relativePath: `org1/canonical/${'c'.repeat(64)}.pdf`, sha256: 'c'.repeat(64),
      pageCount: 2, sealCost: { pages: 2, objects: 40, bytes: 100 },
    },
  });
  mocks.createFile.mockResolvedValue({ id: 'df-new' });
  mocks.createItem.mockResolvedValue({ id: 'i2' });
});

describe('addEnvelopeFile canonical copy', () => {
  it('page count comes from the canonical file, not the client', async () => {
    await upload();

    expect(mocks.createFile).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storagePath: 'org1/new.pdf',
        sha256: 'a'.repeat(64),
        canonicalStoragePath: `org1/canonical/${'c'.repeat(64)}.pdf`,
        canonicalSha256: 'c'.repeat(64),
        canonicalVersion: 1,
        canonicalPageCount: 2,
        canonicalSealCost: { pages: 2, objects: 40, bytes: 100 },
      }),
    });
    expect(mocks.createItem).toHaveBeenCalledWith({
      data: expect.objectContaining({ documentFileId: 'df-new', pageCount: 2 }),
    });
  });
});

describe('addEnvelopeFile envelope-wide caps', () => {
  it('adds a document within the envelope caps', async () => {
    await expect(upload()).resolves.toMatchObject({ item: { id: 'i2' } });
    expect(mocks.createItem).toHaveBeenCalledTimes(1);
  });

  it('refuses a document past the item cap before storing anything', async () => {
    vi.stubEnv('PDF_MAX_ENVELOPE_ITEMS', '1');

    const err = await upload().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UploadValidationError);
    expect((err as UploadValidationError).code).toBe('too_many_documents');
    expect((err as Error).message).toMatch(/at most 1 document/);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.createItem).not.toHaveBeenCalled();
  });

  it('refuses a document that would push the envelope over its seal-cost total', async () => {
    vi.stubEnv('PDF_MAX_ENVELOPE_PAGES', '4');

    const err = await upload().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UploadValidationError);
    expect((err as UploadValidationError).code).toBe('envelope_too_complex');
    expect((err as Error).message).toMatch(/more than 4 pages in total/);
    expect(mocks.createFile).not.toHaveBeenCalled();
    expect(mocks.createItem).not.toHaveBeenCalled();
  });

  it('answers a busy worker while measuring the existing documents with the busy code, not too complex', async () => {
    // A legacy document with no canonical copy yet: the check runs a job for it.
    Object.assign(mocks.existingFile, {
      canonicalStoragePath: null, canonicalSha256: null, canonicalPageCount: null, canonicalSealCost: null,
    });
    mocks.sources.set('org1/three.pdf', await pagesPdf(3));
    vi.mocked(runPdfJob).mockRejectedValueOnce(new PdfWorkerError('busy'));

    const err = await upload().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UploadValidationError);
    expect((err as UploadValidationError).code).toBe('busy');
    expect((err as Error).message).toMatch(/busy processing other documents/);
    expect(mocks.createItem).not.toHaveBeenCalled();
  });
});
