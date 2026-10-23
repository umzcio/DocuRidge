import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { buildBombPdf, doubleFlate } from './pdf/__fixtures__/bomb-pdf';

const uploadsDir = mkdtempSync(join(tmpdir(), 'docuridge-storage-test-'));

vi.mock('./env', () => ({
  getEnv: () => ({ MAX_UPLOAD_BYTES: 26214400, UPLOADS_DIR: uploadsDir }),
}));

const { saveUploadedPdf, UploadValidationError } = await import('./storage');

const MiB = 1024 * 1024;
const ORIGINAL_STREAM_CAP = process.env.PDF_MAX_DECODED_STREAM_BYTES;

describe('saveUploadedPdf decode limits', () => {
  beforeAll(() => {
    process.env.PDF_MAX_DECODED_STREAM_BYTES = String(1 * MiB);
  });

  afterAll(() => {
    if (ORIGINAL_STREAM_CAP === undefined) delete process.env.PDF_MAX_DECODED_STREAM_BYTES;
    else process.env.PDF_MAX_DECODED_STREAM_BYTES = ORIGINAL_STREAM_CAP;
    rmSync(uploadsDir, { recursive: true, force: true });
  });

  for (const where of ['objstm', 'contents'] as const) {
    it(`rejects a nested-FlateDecode ${where} bomb as pdf_too_complex and stores nothing`, async () => {
      const bomb = buildBombPdf(where, doubleFlate(8 * MiB));
      const err = await saveUploadedPdf({ orgId: 'org1', buffer: bomb, declaredMime: 'application/pdf' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UploadValidationError);
      expect((err as InstanceType<typeof UploadValidationError>).code).toBe('pdf_too_complex');
      expect(readdirSync(uploadsDir)).toEqual([]);
    });
  }

  it('accepts an ordinary PDF', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]).drawRectangle({ x: 10, y: 10, width: 50, height: 50 });
    const stored = await saveUploadedPdf({
      orgId: 'org1',
      buffer: Buffer.from(await doc.save()),
      declaredMime: 'application/pdf',
    });
    expect(stored.relativePath).toMatch(/^org1\/[0-9a-f]{64}\.pdf$/);
  });
});
