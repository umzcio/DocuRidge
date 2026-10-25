import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

const mocks = vi.hoisted(() => ({
  sources: new Map<string, Buffer>(),
  existing: [] as Array<{ id: string; order: number; title: string; documentFile: { storagePath: string } }>,
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
    documentFile: { create: mocks.createFile },
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
import { clearSealCostCache } from '../pdf/envelope-seal-check';
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
  clearSealCostCache();
  mocks.sources.set('org1/three.pdf', await pagesPdf(3));
  mocks.existing = [{ id: 'i1', order: 1, title: 'Three.pdf', documentFile: { storagePath: 'org1/three.pdf' } }];
  mocks.save.mockResolvedValue({
    storagePath: '/data/uploads/org1/new.pdf', relativePath: 'org1/new.pdf', sizeBytes: 8,
    sha256: 'a'.repeat(64), mimeType: 'application/pdf', sealCost: { pages: 2, objects: 40, bytes: 100 },
  });
  mocks.createFile.mockResolvedValue({ id: 'df-new' });
  mocks.createItem.mockResolvedValue({ id: 'i2' });
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
    vi.mocked(runPdfJob).mockRejectedValueOnce(new PdfWorkerError('busy'));

    const err = await upload().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UploadValidationError);
    expect((err as UploadValidationError).code).toBe('busy');
    expect((err as Error).message).toMatch(/busy processing other documents/);
    expect(mocks.createItem).not.toHaveBeenCalled();
  });
});
