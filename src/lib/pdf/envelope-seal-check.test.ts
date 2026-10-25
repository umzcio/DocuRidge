import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { encryptedPdf } from './__fixtures__/encrypted-pdf';
import { sharedKidsFormPdf } from './__fixtures__/hostile-form-pdf';
import { opaqueSquareOverText } from './__fixtures__/policy-pdfs';

const uploadsDir = mkdtempSync(join(tmpdir(), 'docuridge-seal-check-test-'));

type Row = Record<string, unknown> & { id: string };

// A stateful stand-in for the document_file table (see canonical-source.test.ts).
const db = vi.hoisted(() => ({ rows: new Map<string, Row>() }));
vi.mock('../prisma', () => ({
  prisma: {
    documentFile: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = db.rows.get(where.id);
        return row ? structuredClone(row) : null;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = db.rows.get(where.id as string);
        if (!row || !Object.entries(where).every(([k, v]) => row[k] === v)) return { count: 0 };
        Object.assign(row, structuredClone(data));
        return { count: 1 };
      },
    },
  },
}));
vi.mock('../env', () => ({ getEnv: () => ({ UPLOADS_DIR: uploadsDir }) }));
const mocks = vi.hoisted(() => ({ decryptPdf: vi.fn() }));
vi.mock('./decrypt', async (orig) => ({
  ...(await orig<typeof import('./decrypt')>()),
  decryptPdf: mocks.decryptPdf,
}));
vi.mock('../pdf-worker/runner', async (orig) => {
  const actual = await orig<typeof import('../pdf-worker/runner')>();
  return { ...actual, runPdfJob: vi.fn(actual.runPdfJob) };
});

const { EnvelopeNotSealableError, assertEnvelopeItemsSealable } = await import('./envelope-seal-check');
const { PdfWorkerError, runPdfJob } = await import('../pdf-worker/runner');
const { QpdfMissingError } = await import('./decrypt');

const realRun = vi.mocked(runPdfJob).getMockImplementation()!;
const ORG = 'orgs';

async function pagesPdf(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([612, 792]).drawText(`page ${i + 1}`, { x: 50, y: 700 });
  return doc.save();
}

/** A legacy row: the original on disk, no canonical columns yet. */
function legacyRow(id: string, bytes: Uint8Array): Row {
  const hash = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(join(uploadsDir, ORG), { recursive: true });
  writeFileSync(join(uploadsDir, ORG, `${hash}.pdf`), bytes);
  const row: Row = {
    id, orgId: ORG, storagePath: `${ORG}/${hash}.pdf`, sha256: hash,
    canonicalStoragePath: null, canonicalSha256: null, canonicalVersion: null,
    canonicalPageCount: null, canonicalSealCost: null, canonicalRefusal: null,
  };
  db.rows.set(id, row);
  return row;
}

const item = (title: string, documentFileId: string) => ({ title, documentFileId });
const jobKinds = () => vi.mocked(runPdfJob).mock.calls.map(([kind]) => kind);
const SEND_FIRST = 'Replace it before sending.';

beforeEach(() => {
  vi.unstubAllEnvs();
  db.rows.clear();
  rmSync(join(uploadsDir, ORG), { recursive: true, force: true });
  vi.mocked(runPdfJob).mockReset();
  vi.mocked(runPdfJob).mockImplementation(realRun);
  mocks.decryptPdf.mockReset();
});

afterAll(() => {
  rmSync(uploadsDir, { recursive: true, force: true });
});

describe('assertEnvelopeItemsSealable', () => {
  it('reads the stored cost without a worker job', async () => {
    legacyRow('a', await pagesPdf(2));
    legacyRow('b', await pagesPdf(3));
    await assertEnvelopeItemsSealable([item('A', 'a'), item('B', 'b')]); // canonicalizes both
    vi.mocked(runPdfJob).mockClear();

    const costs = (await assertEnvelopeItemsSealable([item('A', 'a'), item('B', 'b')])).map((doc) => doc.sealCost);

    expect(costs.map((c) => c.pages)).toEqual([2, 3]);
    expect(vi.mocked(runPdfJob)).toHaveBeenCalledTimes(0);
  });

  it('canonicalizes a legacy item at send', async () => {
    legacyRow('a', await pagesPdf(1));

    const costs = (await assertEnvelopeItemsSealable([item('A', 'a')])).map((doc) => doc.sealCost);

    expect(costs.map((c) => c.pages)).toEqual([1]);
    expect(jobKinds()).toEqual(['canonicalize']);
    expect(db.rows.get('a')!.canonicalSha256).toEqual(expect.any(String));
  });

  it('a refused item names the document and the reason', async () => {
    const { doc } = await opaqueSquareOverText();
    legacyRow('a', await pagesPdf(1));
    legacyRow('marked', await doc.save());

    const err = await assertEnvelopeItemsSealable([item('A', 'a'), item('Marked.pdf', 'marked')]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EnvelopeNotSealableError);
    expect((err as InstanceType<typeof EnvelopeNotSealableError>).retryable).toBe(false);
    expect((err as Error).message).toBe(
      '"Marked.pdf" can\'t be sent: This PDF has comments, markup or stamps that would not appear in the signed copy. Flatten them (for example, print to PDF) and upload again.',
    );
  });

  it('a stored refusal is refused again without a job', async () => {
    legacyRow('a', await pagesPdf(1));
    db.rows.get('a')!.canonicalRefusal = 'hidden_layers';

    await expect(assertEnvelopeItemsSealable([item('A', 'a')])).rejects.toThrow(/^"A" can't be sent: This PDF has hidden layers/);
    expect(vi.mocked(runPdfJob)).toHaveBeenCalledTimes(0);
  });

  it('refuses a document over a per-document cap, naming it', async () => {
    vi.stubEnv('PDF_MAX_PAGES', '2');
    legacyRow('a', await pagesPdf(1));
    legacyRow('big', await pagesPdf(3));

    const err = await assertEnvelopeItemsSealable([item('A', 'a'), item('Big.pdf', 'big')]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EnvelopeNotSealableError);
    expect((err as Error).message).toMatch(/^"Big\.pdf" can't be sent: This PDF is too large or complex/);
  });

  it('refuses a form that sealing could not flatten within its caps', async () => {
    legacyRow('form', await sharedKidsFormPdf(24));

    await expect(assertEnvelopeItemsSealable([item('Form', 'form')])).rejects.toThrow(/^"Form" can't be sent: /);
  });

  it('refuses a document that cannot be read, without leaking its storage path', async () => {
    const row = legacyRow('gone', await pagesPdf(1));
    rmSync(join(uploadsDir, row.storagePath as string));

    const err = await assertEnvelopeItemsSealable([item('Gone', 'gone')]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EnvelopeNotSealableError);
    expect((err as Error).message).toBe(`"Gone" could not be read, so it could not be sealed. ${SEND_FIRST}`);
    expect((err as Error).message).not.toMatch(/orgs\//);
  });

  it('refuses an item whose row does not exist', async () => {
    await expect(assertEnvelopeItemsSealable([item('Nope', 'nope')])).rejects.toThrow(/"Nope" could not be read/);
  });

  it('refuses more documents than the envelope item cap, before any lookup', async () => {
    vi.stubEnv('PDF_MAX_ENVELOPE_ITEMS', '2');

    await expect(assertEnvelopeItemsSealable([item('A', 'a'), item('B', 'a'), item('C', 'a')]))
      .rejects.toThrow(/more than 2 documents/);
    expect(vi.mocked(runPdfJob)).toHaveBeenCalledTimes(0);
  });

  it('refuses documents that each fit but together exceed the envelope totals', async () => {
    vi.stubEnv('PDF_MAX_ENVELOPE_PAGES', '4');
    legacyRow('a', await pagesPdf(3));
    legacyRow('b', await pagesPdf(2));

    const err = await assertEnvelopeItemsSealable([item('A', 'a'), item('B', 'b')]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EnvelopeNotSealableError);
    expect((err as Error).message).toMatch(/more than 4 pages in total/);
  });

  it('counts the cost of a document about to be added', async () => {
    vi.stubEnv('PDF_MAX_ENVELOPE_PAGES', '4');
    legacyRow('a', await pagesPdf(3));

    await expect(assertEnvelopeItemsSealable([item('A', 'a')], [{ pages: 2, objects: 1, bytes: 1 }]))
      .rejects.toThrow(/more than 4 pages in total/);
  });
});

describe('worker and decrypt failures', () => {
  const failWith = (reason: 'busy' | 'unavailable' | 'crashed' | 'timeout') =>
    vi.mocked(runPdfJob).mockRejectedValue(new PdfWorkerError(reason, reason));

  it.each(['busy', 'unavailable'] as const)('%s is retryable and not stored', async (reason) => {
    legacyRow('a', await pagesPdf(1));
    failWith(reason);

    const err = await assertEnvelopeItemsSealable([item('A', 'a')]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EnvelopeNotSealableError);
    expect((err as InstanceType<typeof EnvelopeNotSealableError>).retryable).toBe(true);
    expect((err as Error).message).toBe('DocuRidge is busy processing other documents. Try sending again in a minute.');
    expect(db.rows.get('a')!.canonicalSha256).toBeNull();
    expect(db.rows.get('a')!.canonicalRefusal).toBeNull();

    vi.mocked(runPdfJob).mockImplementation(realRun);
    await expect(assertEnvelopeItemsSealable([item('A', 'a')])).resolves.toHaveLength(1);
  });

  it('busy is retryable and every other refusal is not', async () => {
    legacyRow('a', await pagesPdf(1));
    failWith('busy');
    const busy = await assertEnvelopeItemsSealable([item('A', 'a')]).catch((e: unknown) => e);
    expect((busy as InstanceType<typeof EnvelopeNotSealableError>).retryable).toBe(true);

    failWith('crashed');
    const crashed = await assertEnvelopeItemsSealable([item('A', 'a')]).catch((e: unknown) => e);
    expect((crashed as InstanceType<typeof EnvelopeNotSealableError>).retryable).toBe(false);
  });

  it.each(['timeout', 'out_of_memory'] as const)('a worker %s is unreadable now, not stored as a refusal', async (reason) => {
    legacyRow('a', await pagesPdf(1));
    vi.mocked(runPdfJob).mockRejectedValue(new PdfWorkerError(reason, reason));

    const err = await assertEnvelopeItemsSealable([item('A', 'a')]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EnvelopeNotSealableError);
    expect((err as InstanceType<typeof EnvelopeNotSealableError>).retryable).toBe(false);
    expect((err as Error).message).toBe(`"A" could not be read, so it could not be sealed. ${SEND_FIRST}`);
    expect(db.rows.get('a')!.canonicalRefusal).toBeNull();
    expect(db.rows.get('a')!.canonicalSha256).toBeNull();

    // Nothing was stored, so the next send canonicalizes it.
    vi.mocked(runPdfJob).mockImplementation(realRun);
    await expect(assertEnvelopeItemsSealable([item('A', 'a')])).resolves.toHaveLength(1);
  });

  it('a canonical copy that cannot be written never shows the file-system text', async () => {
    legacyRow('a', await pagesPdf(1));
    const storage = await import('../storage');
    const write = vi.spyOn(storage, 'writeCanonicalPdf').mockRejectedValue(
      Object.assign(new Error(`EACCES: permission denied, open '${uploadsDir}/orgs/canonical/x.pdf'`), { code: 'EACCES' }),
    );
    try {
      const err = await assertEnvelopeItemsSealable([item('A', 'a')]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EnvelopeNotSealableError);
      expect((err as Error).message).toBe(`"A" could not be read, so it could not be sealed. ${SEND_FIRST}`);
      expect((err as Error).message).not.toMatch(/EACCES|permission|canonical\/|orgs/);
      expect(db.rows.get('a')!.canonicalSha256).toBeNull();
      expect(db.rows.get('a')!.canonicalRefusal).toBeNull();
    } finally {
      write.mockRestore();
    }
  });

  it('any other failure is logged by name and answered with the fixed text', async () => {
    legacyRow('a', await pagesPdf(1));
    const prismaModule = await import('../prisma');
    const find = vi.spyOn(prismaModule.prisma.documentFile, 'findUnique').mockRejectedValue(
      new Error('Invalid `prisma.documentFile.findUnique()` invocation: connection to /var/run/postgresql failed'),
    );
    try {
      const err = await assertEnvelopeItemsSealable([item('A', 'a')]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EnvelopeNotSealableError);
      expect((err as Error).message).toBe(`"A" could not be read, so it could not be sealed. ${SEND_FIRST}`);
      expect((err as Error).message).not.toMatch(/prisma|postgres/i);
    } finally {
      find.mockRestore();
    }
  });

  it('a crashed worker is unreadable, non-retryable and not stored', async () => {
    legacyRow('a', await pagesPdf(1));
    failWith('crashed');

    const err = await assertEnvelopeItemsSealable([item('A', 'a')]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EnvelopeNotSealableError);
    expect((err as InstanceType<typeof EnvelopeNotSealableError>).retryable).toBe(false);
    expect((err as Error).message).toBe(`"A" could not be read, so it could not be sealed. ${SEND_FIRST}`);
    expect(db.rows.get('a')!.canonicalRefusal).toBeNull();
  });

  it('a job failure never shows the child\'s text', async () => {
    legacyRow('a', await pagesPdf(1));
    vi.mocked(runPdfJob).mockRejectedValue(new Error('child text at /app/pdf-worker.cjs'));

    const err = await assertEnvelopeItemsSealable([item('A', 'a')]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EnvelopeNotSealableError);
    expect((err as Error).message).toBe(`"A" could not be read, so it could not be sealed. ${SEND_FIRST}`);
    expect(db.rows.get('a')!.canonicalRefusal).toBeNull();
  });

  it('a missing qpdf is unreadable and not stored', async () => {
    legacyRow('a', await encryptedPdf('aes'));
    mocks.decryptPdf.mockRejectedValue(new QpdfMissingError());

    const err = await assertEnvelopeItemsSealable([item('A', 'a')]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EnvelopeNotSealableError);
    expect((err as InstanceType<typeof EnvelopeNotSealableError>).retryable).toBe(false);
    expect((err as Error).message).toBe(`"A" could not be read, so it could not be sealed. ${SEND_FIRST}`);
    expect(db.rows.get('a')!.canonicalRefusal).toBeNull();
  });
});
