import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { PDFDocument } from 'pdf-lib';
import { optionalContentPdf } from '../pdf/__fixtures__/policy-pdfs';
import { encryptedPdf } from '../pdf/__fixtures__/encrypted-pdf';
import { seedCanonicalDocument, seedLegacyDocument, type Row } from '../documents/__fixtures__/stored-documents';

const uploadsDir = mkdtempSync(join(tmpdir(), 'docuridge-backfill-test-'));

type Match = Record<string, unknown>;
const db = vi.hoisted(() => ({
  files: new Map<string, Record<string, unknown> & { id: string }>(),
  items: new Map<string, Record<string, unknown> & { id: string }>(),
  fields: new Map<string, Record<string, unknown> & { id: string }>(),
  envelopes: new Map<string, { id: string; status: string }>(),
  writes: 0,
  clears: [] as unknown[],
}));

// Equality, or `{ not: null }`, per column: all the backfill's queries use.
const matches = (row: Match, where: Match) =>
  Object.entries(where).every(([k, v]) =>
    typeof v === 'object' && v !== null && 'not' in v ? row[k] !== (v as { not: unknown }).not : row[k] === v,
  );
const pick = (row: Match, select?: Match) =>
  structuredClone(select ? Object.fromEntries(Object.keys(select).filter((k) => k in row).map((k) => [k, row[k]])) : row);

vi.mock('../prisma', () => ({
  prisma: {
    documentFile: {
      // Only files that some envelope item references.
      findMany: async () =>
        [...db.files.values()].filter((f) => [...db.items.values()].some((i) => i.documentFileId === f.id)).map((f) => ({ id: f.id })),
      findUnique: async ({ where, select }: { where: { id: string }; select?: Match }) => {
        const row = db.files.get(where.id);
        return row ? pick(row, select) : null;
      },
      updateMany: async ({ where, data }: { where: Match; data: Match }) => {
        const row = db.files.get(where.id as string);
        if (!row || !matches(row, where)) return { count: 0 };
        // Prisma refuses a bare null for a Json column; it wants Prisma.DbNull.
        if (data.canonicalSealCost === null) throw new Error('null is not valid for a Json column');
        db.clears.push(data.canonicalSealCost);
        const { canonicalSealCost, ...rest } = data;
        Object.assign(row, structuredClone(rest));
        if (canonicalSealCost !== undefined) row.canonicalSealCost = canonicalSealCost === Prisma.DbNull ? null : canonicalSealCost;
        db.writes++;
        return { count: 1 };
      },
    },
    envelopeItem: {
      findMany: async ({ where }: { where: { documentFileId: string } }) =>
        [...db.items.values()]
          .filter((i) => i.documentFileId === where.documentFileId)
          .map((i) => ({ ...structuredClone(i), envelope: { status: db.envelopes.get(i.envelopeId as string)!.status } })),
      update: async ({ where, data }: { where: { id: string }; data: Match }) => {
        Object.assign(db.items.get(where.id)!, data);
        db.writes++;
      },
    },
    field: {
      findMany: async ({ where }: { where: { envelopeItemId: string; page: { gt: number } } }) =>
        [...db.fields.values()]
          .filter((f) => f.envelopeItemId === where.envelopeItemId && (f.page as number) > where.page.gt)
          .map((f) => structuredClone(f)),
    },
  },
}));
vi.mock('../env', () => ({ getEnv: () => ({ UPLOADS_DIR: uploadsDir }) }));
const mocks = vi.hoisted(() => ({ decryptPdf: vi.fn() }));
vi.mock('../pdf/decrypt', async (orig) => ({
  ...(await orig<typeof import('../pdf/decrypt')>()),
  decryptPdf: mocks.decryptPdf,
}));
vi.mock('../pdf-worker/runner', async (orig) => {
  const actual = await orig<typeof import('../pdf-worker/runner')>();
  return { ...actual, runPdfJob: vi.fn(actual.runPdfJob) };
});

const { main } = await import('./canonical-backfill');
const { CURRENT_CANONICAL_VERSION } = await import('../pdf/canonical-source');
const { PdfWorkerError, runPdfJob } = await import('../pdf-worker/runner');
const { QpdfMissingError } = await import('../pdf/decrypt');

const realRun = vi.mocked(runPdfJob).getMockImplementation()!;

async function pages(count: number, label = 'Page'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([612, 792]).drawText(`${label} ${i + 1}`, { x: 50, y: 700 });
  return doc.save();
}

function addItem(file: Row, id: string, envelopeId: string, status: string, pageCount: number, title = id): void {
  db.envelopes.set(envelopeId, { id: envelopeId, status });
  db.items.set(id, { id, envelopeId, documentFileId: file.id, title, pageCount });
}

async function run(...argv: string[]): Promise<{ code: number; lines: Array<Record<string, any>>; text: string }> {
  const out: string[] = [];
  const code = await main(argv, { stdout: (l) => out.push(l) });
  return { code, lines: out.map((l) => JSON.parse(l)), text: out.join('\n') };
}

const filesOnDisk = () => readdirSync(uploadsDir, { recursive: true }).map(String).sort();

beforeEach(() => {
  db.files.clear(); db.items.clear(); db.fields.clear(); db.envelopes.clear(); db.writes = 0; db.clears = [];
  vi.mocked(runPdfJob).mockReset().mockImplementation(realRun);
  mocks.decryptPdf.mockReset();
});
afterAll(() => rmSync(uploadsDir, { recursive: true, force: true }));

describe('canonical backfill', () => {
  it('canonicalizes legacy rows, skips finished ones, reports refusals with their envelope, and is idempotent', async () => {
    const legacy = seedLegacyDocument(db.files, uploadsDir, 'f-legacy', await pages(2));
    const { row: done } = await seedCanonicalDocument(db.files, uploadsDir, 'f-done', await pages(1, 'Done'));
    const hidden = seedLegacyDocument(db.files, uploadsDir, 'f-hidden', (await (await optionalContentPdf('off')).doc.save()));
    const orphan = seedLegacyDocument(db.files, uploadsDir, 'f-sealed-output', await pages(1, 'Sealed'));
    addItem(legacy, 'i1', 'e1', 'DRAFT', 2);
    addItem(done, 'i2', 'e2', 'COMPLETED', 1);
    addItem(hidden, 'i3', 'e3', 'SENT', 1, 'Lease');
    expect(orphan.canonicalSha256).toBeNull();

    const first = await run();
    const byId = Object.fromEntries(first.lines.filter((l) => l.documentFileId).map((l) => [l.documentFileId, l]));
    expect(byId['f-legacy']).toMatchObject({ status: 'ok', items: [{ envelopeId: 'e1', status: 'DRAFT', title: 'i1' }] });
    expect(byId['f-done'].status).toBe('already');
    expect(byId['f-hidden']).toMatchObject({
      status: 'refused', key: 'hidden_layers', items: [{ envelopeId: 'e3', status: 'SENT', title: 'Lease' }],
    });
    expect(byId['f-sealed-output']).toBeUndefined();
    expect(db.files.get('f-sealed-output')!.canonicalSha256).toBeNull();
    expect(db.files.get('f-legacy')!.canonicalSha256).toEqual(expect.any(String));
    expect(db.files.get('f-hidden')!.canonicalRefusal).toBe('hidden_layers');
    expect(first.lines.at(-1)).toMatchObject({ summary: true, total: 3, ok: 1, already: 1, refused: 1, busy: 0, error: 0 });
    expect(first.code).toBe(0);

    const jobsBefore = vi.mocked(runPdfJob).mock.calls.length;
    const second = await run();
    expect(vi.mocked(runPdfJob).mock.calls.length).toBe(jobsBefore);
    expect(second.lines.at(-1)).toMatchObject({ already: 2, refused: 1, ok: 0 });
  });

  it('--dry-run reports the same statuses but writes no file and no row', async () => {
    const legacy = seedLegacyDocument(db.files, uploadsDir, 'f-legacy', await pages(2));
    const hidden = seedLegacyDocument(db.files, uploadsDir, 'f-hidden', await (await optionalContentPdf('off')).doc.save());
    addItem(legacy, 'i1', 'e1', 'DRAFT', 1);
    addItem(hidden, 'i2', 'e2', 'SENT', 1);
    const rowsBefore = structuredClone([...db.files.values()]);
    const itemsBefore = structuredClone([...db.items.values()]);
    const diskBefore = filesOnDisk();

    const { lines, code } = await run('--dry-run');
    expect(lines.find((l) => l.documentFileId === 'f-legacy')).toMatchObject({
      status: 'ok', pageCountFixed: [{ itemId: 'i1', from: 1, to: 2 }],
    });
    expect(lines.find((l) => l.documentFileId === 'f-hidden')).toMatchObject({ status: 'refused', key: 'hidden_layers' });
    expect(lines.at(-1)).toMatchObject({ summary: true, dryRun: true });
    expect(code).toBe(0);
    expect([...db.files.values()]).toEqual(rowsBefore);
    expect([...db.items.values()]).toEqual(itemsBefore);
    expect(filesOnDisk()).toEqual(diskBefore);
    expect(db.writes).toBe(0);
  });

  it('fixes an item page count from the canonical count and reports fields beyond it', async () => {
    const file = seedLegacyDocument(db.files, uploadsDir, 'f1', await pages(2));
    addItem(file, 'i1', 'e1', 'DRAFT', 5);
    db.fields.set('fld3', { id: 'fld3', envelopeItemId: 'i1', page: 3 });
    db.fields.set('fld2', { id: 'fld2', envelopeItemId: 'i1', page: 2 });

    const { lines } = await run();
    expect(lines[0]).toMatchObject({
      status: 'ok',
      pageCountFixed: [{ envelopeId: 'e1', itemId: 'i1', from: 5, to: 2 }],
      fieldsOutOfRange: [{ envelopeId: 'e1', itemId: 'i1', fieldId: 'fld3', page: 3 }],
    });
    expect(db.items.get('i1')!.pageCount).toBe(2);
    expect(lines.at(-1)).toMatchObject({ pageCountFixed: 1, fieldsOutOfRange: 1 });
  });

  it('--retry-refused clears a stored refusal and tries again; without it the refusal stands', async () => {
    const file = seedLegacyDocument(db.files, uploadsDir, 'f1', await pages(1));
    Object.assign(file, { canonicalRefusal: 'self_check', canonicalVersion: CURRENT_CANONICAL_VERSION });
    addItem(file, 'i1', 'e1', 'SENT', 1);

    const plain = await run();
    expect(plain.lines[0]).toMatchObject({ status: 'refused', key: 'self_check' });
    expect(vi.mocked(runPdfJob)).not.toHaveBeenCalled();

    const retried = await run('--retry-refused');
    expect(retried.lines[0]!.status).toBe('ok');
    expect(db.files.get('f1')).toMatchObject({ canonicalRefusal: null, canonicalVersion: CURRENT_CANONICAL_VERSION });
    expect(db.clears[0]).toBe(Prisma.DbNull);
  });

  it('--recanonicalize redoes only rows below the current version', async () => {
    const { row } = await seedCanonicalDocument(db.files, uploadsDir, 'old', await pages(1, 'Old'));
    const { row: current } = await seedCanonicalDocument(db.files, uploadsDir, 'new', await pages(1, 'New'));
    row.canonicalVersion = CURRENT_CANONICAL_VERSION - 1;
    addItem(row, 'i1', 'e1', 'COMPLETED', 1);
    addItem(current, 'i2', 'e2', 'COMPLETED', 1);

    const kept = await run();
    expect(kept.lines.filter((l) => l.status === 'already')).toHaveLength(2);
    expect(vi.mocked(runPdfJob)).not.toHaveBeenCalled();

    const redone = await run('--recanonicalize');
    const status = Object.fromEntries(redone.lines.filter((l) => l.documentFileId).map((l) => [l.documentFileId, l.status]));
    expect(status).toEqual({ old: 'ok', new: 'already' });
    expect(db.files.get('old')!.canonicalVersion).toBe(CURRENT_CANONICAL_VERSION);
    expect(vi.mocked(runPdfJob)).toHaveBeenCalledTimes(1);
  });

  it('maps worker busy to busy, other failures to a fixed error category, and exits non-zero', async () => {
    const busy = seedLegacyDocument(db.files, uploadsDir, 'f-busy', await pages(1, 'A'));
    const crash = seedLegacyDocument(db.files, uploadsDir, 'f-crash', await pages(1, 'B'));
    const ok = seedLegacyDocument(db.files, uploadsDir, 'f-ok', await pages(1, 'C'));
    addItem(busy, 'i1', 'e1', 'SENT', 1);
    addItem(crash, 'i2', 'e2', 'SENT', 1);
    addItem(ok, 'i3', 'e3', 'SENT', 1);
    // Rows run in id order: f-busy, f-crash, f-ok.
    let call = 0;
    vi.mocked(runPdfJob).mockImplementation(async (kind, input, opts) => {
      call++;
      if (call === 1) throw new PdfWorkerError('busy');
      if (call === 2) throw new Error('secret path /srv/uploads/x.pdf');
      return realRun(kind, input, opts);
    });

    const { lines, code, text } = await run();
    const byId = Object.fromEntries(lines.filter((l) => l.documentFileId).map((l) => [l.documentFileId, l]));
    expect(byId['f-busy'].status).toBe('busy');
    expect(byId['f-crash']).toMatchObject({ status: 'error', error: 'worker_crashed' });
    expect(byId['f-ok'].status).toBe('ok');
    expect(db.files.get('f-busy')!.canonicalSha256).toBeNull();
    expect(lines.at(-1)).toMatchObject({ busy: 1, error: 1, ok: 1 });
    expect(code).toBe(1);
    expect(text).not.toContain('secret path');
  });

  it('reports a missing qpdf as an error, and a refusal key for a file qpdf cannot open', async () => {
    const enc = seedLegacyDocument(db.files, uploadsDir, 'f-enc', await encryptedPdf('rc4'));
    addItem(enc, 'i1', 'e1', 'SENT', 1);
    mocks.decryptPdf.mockRejectedValue(new QpdfMissingError());
    const missing = await run();
    expect(missing.lines[0]).toMatchObject({ status: 'error', error: 'qpdf_missing' });
    expect(missing.code).toBe(1);

    mocks.decryptPdf.mockRejectedValue(new Error('bad password'));
    const dry = await run('--dry-run');
    expect(dry.lines[0]).toMatchObject({ status: 'refused', key: 'unreadable_pdf' });
  });

  it('prints no original sha256 and no storage path', async () => {
    const file = seedLegacyDocument(db.files, uploadsDir, 'f1', await pages(1));
    addItem(file, 'i1', 'e1', 'DRAFT', 1, 'Contract');
    const { text } = await run();
    expect(text).not.toContain(file.sha256 as string);
    expect(text).not.toContain(file.storagePath as string);
  });

  it('rejects an unknown flag with exit code 2 and runs nothing', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(['--nope'], { stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err.join('')).toContain('Usage');
  });
});
