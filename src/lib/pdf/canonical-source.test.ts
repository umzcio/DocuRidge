import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { encryptedPdf } from './__fixtures__/encrypted-pdf';
import { opaqueSquareOverText } from './__fixtures__/policy-pdfs';

const uploadsDir = mkdtempSync(join(tmpdir(), 'docuridge-canonical-source-test-'));

type Row = Record<string, unknown> & { id: string };

// A stateful stand-in for the document_file table: findUnique returns a copy
// of the row, and updateMany writes only when every `where` column still
// holds the given value, as the database's conditional UPDATE does.
const db = vi.hoisted(() => ({ rows: new Map<string, Row>(), writes: 0 }));
vi.mock('../prisma', () => ({
  prisma: {
    documentFile: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        await Promise.resolve();
        const row = db.rows.get(where.id);
        return row ? structuredClone(row) : null;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        await Promise.resolve();
        const row = db.rows.get(where.id as string);
        if (!row || !Object.entries(where).every(([k, v]) => row[k] === v)) return { count: 0 };
        Object.assign(row, structuredClone(data));
        db.writes++;
        return { count: 1 };
      },
    },
  },
}));
vi.mock('../env', () => ({ getEnv: () => ({ MAX_UPLOAD_BYTES: 26214400, UPLOADS_DIR: uploadsDir }) }));
const mocks = vi.hoisted(() => ({ decryptPdf: vi.fn() }));
vi.mock('./decrypt', async (orig) => ({
  ...(await orig<typeof import('./decrypt')>()),
  decryptPdf: mocks.decryptPdf,
}));
vi.mock('../pdf-worker/runner', async (orig) => {
  const actual = await orig<typeof import('../pdf-worker/runner')>();
  return { ...actual, runPdfJob: vi.fn(actual.runPdfJob) };
});

const { CURRENT_CANONICAL_VERSION, CanonicalRefusedError, ensureCanonicalDocument, ensureEnvelopeCanonical } =
  await import('./canonical-source');
const { CanonicalUnavailableError, readCanonicalPdf } = await import('../storage');
const { PdfWorkerError, runPdfJob } = await import('../pdf-worker/runner');
const { QpdfBusyError, QpdfMissingError, QpdfOutputTooLargeError, QpdfPasswordError } = await import('./decrypt');
const { canonicalizeUploadedPdf } = await import('./canonicalize');

const realRun = vi.mocked(runPdfJob).getMockImplementation()!;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ORG = 'orgc';

async function pages(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([612, 792]).drawText(`Page ${i + 1}`, { x: 50, y: 700 });
  return doc.save();
}

/** A legacy row: the original on disk, no canonical columns yet. */
function legacyRow(id: string, bytes: Uint8Array): Row {
  const hash = sha(bytes);
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

const canonicalColumns = (row: Row) => ({
  canonicalStoragePath: row.canonicalStoragePath, canonicalSha256: row.canonicalSha256,
  canonicalVersion: row.canonicalVersion, canonicalPageCount: row.canonicalPageCount,
  canonicalSealCost: row.canonicalSealCost, canonicalRefusal: row.canonicalRefusal,
});
const UNSET = {
  canonicalStoragePath: null, canonicalSha256: null, canonicalVersion: null,
  canonicalPageCount: null, canonicalSealCost: null, canonicalRefusal: null,
};

const jobKinds = () => vi.mocked(runPdfJob).mock.calls.map(([kind]) => kind);

beforeEach(() => {
  db.rows.clear();
  db.writes = 0;
  rmSync(join(uploadsDir, ORG), { recursive: true, force: true });
  vi.mocked(runPdfJob).mockReset();
  vi.mocked(runPdfJob).mockImplementation(realRun);
  mocks.decryptPdf.mockReset();
});

afterAll(() => {
  rmSync(uploadsDir, { recursive: true, force: true });
});

describe('ensureCanonicalDocument', () => {
  it('canonicalizes a legacy row on demand and stores the columns', async () => {
    const original = await pages(2);
    legacyRow('df1', original);

    const doc = await ensureCanonicalDocument('df1');

    expect(doc.documentFileId).toBe('df1');
    expect(doc.pageCount).toBe(2);
    expect(doc.sealCost.pages).toBe(2);
    expect(doc.storagePath).toBe(`${ORG}/canonical/${doc.sha256}.pdf`);
    const expected = await canonicalizeUploadedPdf(original);
    if (!expected.ok) throw new Error('fixture did not canonicalize');
    expect(doc.sha256).toBe(sha(expected.bytes));
    expect((await readCanonicalPdf(doc)).equals(Buffer.from(expected.bytes))).toBe(true);
    expect(canonicalColumns(db.rows.get('df1')!)).toEqual({
      canonicalStoragePath: doc.storagePath,
      canonicalSha256: doc.sha256,
      canonicalVersion: CURRENT_CANONICAL_VERSION,
      canonicalPageCount: 2,
      canonicalSealCost: doc.sealCost,
      canonicalRefusal: null,
    });
    // Legacy rows may predate decryption at upload, so the job may parse an encrypted file far enough to say so.
    expect(vi.mocked(runPdfJob).mock.calls).toEqual([['canonicalize', expect.objectContaining({ ignoreEncryption: true })]]);
    // The original is untouched.
    expect(readFileSync(join(uploadsDir, db.rows.get('df1')!.storagePath as string)).equals(Buffer.from(original))).toBe(true);
  });

  it('returns the stored copy without a job', async () => {
    legacyRow('df1', await pages(1));
    const first = await ensureCanonicalDocument('df1');
    vi.mocked(runPdfJob).mockClear();

    await expect(ensureCanonicalDocument('df1')).resolves.toEqual(first);
    expect(vi.mocked(runPdfJob)).toHaveBeenCalledTimes(0);
    expect(db.writes).toBe(1);
  });

  it('returns a stored copy of an older version as it is, without a job', async () => {
    legacyRow('df1', await pages(1));
    const first = await ensureCanonicalDocument('df1');
    db.rows.get('df1')!.canonicalVersion = 0;
    vi.mocked(runPdfJob).mockClear();

    await expect(ensureCanonicalDocument('df1')).resolves.toEqual(first);
    expect(vi.mocked(runPdfJob)).toHaveBeenCalledTimes(0);
  });

  it('stores a refusal and does not retry it', async () => {
    const { doc } = await opaqueSquareOverText();
    legacyRow('df1', await doc.save());

    const err = await ensureCanonicalDocument('df1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CanonicalRefusedError);
    expect((err as InstanceType<typeof CanonicalRefusedError>).key).toBe('visible_annotations');
    expect((err as Error).message).toBe(
      'This PDF has comments, markup or stamps that would not appear in the signed copy. Flatten them (for example, print to PDF) and upload again.',
    );
    expect(canonicalColumns(db.rows.get('df1')!)).toEqual({
      ...UNSET, canonicalRefusal: 'visible_annotations', canonicalVersion: CURRENT_CANONICAL_VERSION,
    });

    vi.mocked(runPdfJob).mockClear();
    const again = await ensureCanonicalDocument('df1').catch((e: unknown) => e);
    expect(again).toBeInstanceOf(CanonicalRefusedError);
    expect((again as InstanceType<typeof CanonicalRefusedError>).key).toBe('visible_annotations');
    expect(vi.mocked(runPdfJob)).toHaveBeenCalledTimes(0);
    expect(readdirSync(join(uploadsDir, ORG))).not.toContain('canonical');
  });

  it.each(['busy', 'unavailable', 'crashed'] as const)('%s is not stored', async (reason) => {
    legacyRow('df1', await pages(1));
    vi.mocked(runPdfJob).mockRejectedValue(new PdfWorkerError(reason));

    const err = await ensureCanonicalDocument('df1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfWorkerError);
    expect((err as InstanceType<typeof PdfWorkerError>).reason).toBe(reason);
    expect(canonicalColumns(db.rows.get('df1')!)).toEqual(UNSET);
    expect(db.writes).toBe(0);

    // The next call runs the job again, and succeeds.
    vi.mocked(runPdfJob).mockImplementation(realRun);
    await expect(ensureCanonicalDocument('df1')).resolves.toMatchObject({ pageCount: 1 });
  });

  it.each(['timeout', 'out_of_memory'] as const)('a worker %s propagates and is not stored', async (reason) => {
    legacyRow('df1', await pages(1));
    vi.mocked(runPdfJob).mockRejectedValue(new PdfWorkerError(reason));

    const err = await ensureCanonicalDocument('df1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfWorkerError);
    expect((err as InstanceType<typeof PdfWorkerError>).reason).toBe(reason);
    expect(db.rows.get('df1')!.canonicalRefusal).toBeNull();
    expect(db.rows.get('df1')!.canonicalSha256).toBeNull();

    // A loaded host's timeout is not the file's fault: the next access tries again.
    vi.mocked(runPdfJob).mockReset().mockImplementation(realRun);
    await expect(ensureCanonicalDocument('df1')).resolves.toMatchObject({ pageCount: 1 });
  });

  it('a copy that cannot be written is unavailable, not stored, and never carries the file-system text', async () => {
    legacyRow('df1', await pages(1));
    const storage = await import('../storage');
    const write = vi.spyOn(storage, 'writeCanonicalPdf').mockRejectedValue(new Error('ENOSPC: no space left on device, write /data/uploads/x'));
    try {
      const err = await ensureCanonicalDocument('df1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CanonicalUnavailableError);
      expect((err as Error).message).not.toMatch(/ENOSPC|uploads/);
      expect(db.rows.get('df1')!.canonicalSha256).toBeNull();
      expect(db.rows.get('df1')!.canonicalRefusal).toBeNull();
    } finally {
      write.mockRestore();
    }
  });

  it('two concurrent calls for one row both succeed with one canonical', async () => {
    legacyRow('df1', await pages(3));

    const [a, b] = await Promise.all([ensureCanonicalDocument('df1'), ensureCanonicalDocument('df1')]);

    expect(a).toEqual(b);
    expect(jobKinds()).toEqual(['canonicalize', 'canonicalize']); // both missed, both ran
    expect(db.writes).toBe(1); // the row was written once
    expect(db.rows.get('df1')!.canonicalSha256).toBe(a.sha256);
    expect(readdirSync(join(uploadsDir, ORG, 'canonical'))).toEqual([`${a.sha256}.pdf`]);
  });

  it('returns the winner\'s values when another caller stored the row first', async () => {
    legacyRow('df1', await pages(1));
    const winner = {
      canonicalStoragePath: `${ORG}/canonical/${'a'.repeat(64)}.pdf`, canonicalSha256: 'a'.repeat(64),
      canonicalVersion: CURRENT_CANONICAL_VERSION, canonicalPageCount: 1,
      canonicalSealCost: { pages: 1, objects: 9, bytes: 99 },
    };
    // The other caller commits while this one's job is running.
    vi.mocked(runPdfJob).mockImplementationOnce(async (kind, input, opts) => {
      Object.assign(db.rows.get('df1')!, winner);
      return realRun(kind, input, opts);
    });

    await expect(ensureCanonicalDocument('df1')).resolves.toEqual({
      documentFileId: 'df1', storagePath: winner.canonicalStoragePath, sha256: winner.canonicalSha256,
      pageCount: 1, sealCost: winner.canonicalSealCost,
    });
    expect(db.writes).toBe(0);
  });

  it('decrypts an encrypted legacy row in the parent and canonicalizes the decrypted bytes', async () => {
    const original = await encryptedPdf('aes');
    legacyRow('df1', original);
    const decrypted = Buffer.from(await pages(1));
    mocks.decryptPdf.mockResolvedValue(decrypted);

    const doc = await ensureCanonicalDocument('df1');

    expect(mocks.decryptPdf).toHaveBeenCalledTimes(1);
    expect(Buffer.from(mocks.decryptPdf.mock.calls[0]![0] as Uint8Array).equals(Buffer.from(original))).toBe(true);
    expect(mocks.decryptPdf.mock.calls[0]![1]).toEqual({ maxOutputBytes: 2 * 26214400 });
    expect(jobKinds()).toEqual(['canonicalize', 'canonicalize']);
    const expected = await canonicalizeUploadedPdf(decrypted);
    if (!expected.ok) throw new Error('fixture did not canonicalize');
    expect(doc.sha256).toBe(sha(expected.bytes));
    // The original row and file are never rewritten.
    const row = db.rows.get('df1')!;
    expect(row.storagePath).toBe(`${ORG}/${sha(original)}.pdf`);
    expect(row.sha256).toBe(sha(original));
    expect(readFileSync(join(uploadsDir, row.storagePath as string)).equals(Buffer.from(original))).toBe(true);
  });

  it.each([
    ['a password the parent cannot remove', () => mocks.decryptPdf.mockRejectedValue(new QpdfPasswordError('invalid password'))],
    ['a decrypt failure', () => mocks.decryptPdf.mockRejectedValue(new Error('qpdf exploded'))],
    ['a decrypted output over the upload cap', () => mocks.decryptPdf.mockRejectedValue(new QpdfOutputTooLargeError(26214400))],
    ['bytes still encrypted after decryption', async () => mocks.decryptPdf.mockResolvedValue(Buffer.from(await encryptedPdf('rc4')))],
  ])('stores %s as unreadable', async (_name, arrange) => {
    legacyRow('df1', await encryptedPdf('aes'));
    await arrange();

    const err = await ensureCanonicalDocument('df1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CanonicalRefusedError);
    expect((err as InstanceType<typeof CanonicalRefusedError>).key).toBe('unreadable_pdf');
    expect(db.rows.get('df1')!.canonicalRefusal).toBe('unreadable_pdf');
  });

  it('a failed job propagates as crashed, never as the child\'s text, and is not stored', async () => {
    legacyRow('df1', await pages(1));
    vi.mocked(runPdfJob).mockRejectedValue(new Error('child text at /app/pdf-worker.cjs'));

    const err = await ensureCanonicalDocument('df1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PdfWorkerError);
    expect((err as InstanceType<typeof PdfWorkerError>).reason).toBe('crashed');
    expect((err as Error).message).not.toMatch(/child text/);
    expect(canonicalColumns(db.rows.get('df1')!)).toEqual(UNSET);
  });

  it('a missing qpdf is a deployment fault: it propagates and nothing is stored', async () => {
    legacyRow('df1', await encryptedPdf('aes'));
    mocks.decryptPdf.mockRejectedValue(new QpdfMissingError());

    await expect(ensureCanonicalDocument('df1')).rejects.toBeInstanceOf(QpdfMissingError);
    expect(canonicalColumns(db.rows.get('df1')!)).toEqual(UNSET);
    expect(db.writes).toBe(0);
  });

  it('a full qpdf queue propagates as a busy worker and nothing is stored', async () => {
    legacyRow('df1', await encryptedPdf('aes'));
    mocks.decryptPdf.mockRejectedValue(new QpdfBusyError());

    const err = await ensureCanonicalDocument('df1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfWorkerError);
    expect((err as InstanceType<typeof PdfWorkerError>).reason).toBe('busy');
    expect(canonicalColumns(db.rows.get('df1')!)).toEqual(UNSET);
    expect(db.writes).toBe(0);
  });

  it('a missing original is unavailable and not stored', async () => {
    const row = legacyRow('df1', await pages(1));
    rmSync(join(uploadsDir, row.storagePath as string));

    await expect(ensureCanonicalDocument('df1')).rejects.toBeInstanceOf(CanonicalUnavailableError);
    expect(canonicalColumns(db.rows.get('df1')!)).toEqual(UNSET);
    expect(vi.mocked(runPdfJob)).toHaveBeenCalledTimes(0);
  });

  it('an unknown row is unavailable', async () => {
    await expect(ensureCanonicalDocument('nope')).rejects.toBeInstanceOf(CanonicalUnavailableError);
  });

  it('a stored seal cost that is not a cost is unavailable, not trusted', async () => {
    legacyRow('df1', await pages(1));
    await ensureCanonicalDocument('df1');
    db.rows.get('df1')!.canonicalSealCost = { pages: 1, objects: -1, bytes: 10 };

    await expect(ensureCanonicalDocument('df1')).rejects.toBeInstanceOf(CanonicalUnavailableError);
  });
});

describe('ensureEnvelopeCanonical', () => {
  it('returns each item\'s canonical document in item order', async () => {
    legacyRow('df1', await pages(1));
    legacyRow('df2', await pages(2));

    const docs = await ensureEnvelopeCanonical([
      { title: 'Two.pdf', documentFileId: 'df2' },
      { title: 'One.pdf', documentFileId: 'df1' },
    ]);

    expect(docs.map((d) => [d.documentFileId, d.pageCount])).toEqual([['df2', 2], ['df1', 1]]);
  });
});
