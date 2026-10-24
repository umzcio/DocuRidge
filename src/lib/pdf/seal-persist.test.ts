import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sealedDir = mkdtempSync(join(tmpdir(), 'docuridge-sealed-test-'));

interface Db {
  status: string;
  documentFiles: Array<Record<string, unknown>>;
  sealed: Record<string, unknown> | null;
  events: Array<Record<string, unknown>>;
  failRecord: boolean;
}
const db = vi.hoisted(() => ({ state: null as unknown as Db }));

vi.mock('../env', () => ({ getEnv: () => ({ SEALED_DIR: sealedDir }) }));
vi.mock('../prisma', () => ({ prisma: {} }));
vi.mock('../crypto/org-key', () => ({ getOrCreateOrgKey: vi.fn(), signHex: vi.fn() }));
vi.mock('../audit/envelope', async () => {
  // One transaction at a time per envelope, like the envelope row lock; each
  // commits atomically or not at all.
  let lock: Promise<unknown> = Promise.resolve();
  return {
    canonicalJson: (await import('../audit/canonical')).canonicalJson,
    commitWithEnvelopeEvents: (
      _envelopeId: string,
      fn: (tx: unknown, record: (e: Record<string, unknown>) => Promise<void>) => Promise<unknown>,
    ) => {
      const run = lock.then(async () => {
        const draft = {
          ...db.state,
          documentFiles: [...db.state.documentFiles],
          events: [...db.state.events],
        };
        const tx = {
          envelope: {
            updateMany: async ({ where }: { where: { status: string } }) =>
              ({ count: draft.status === where.status ? 1 : 0 }),
          },
          sealedDocument: {
            findUnique: async () => draft.sealed,
            create: async ({ data }: { data: Record<string, unknown> }) => {
              if (draft.sealed) throw new Error('Unique constraint failed on the fields: (`envelopeId`)');
              draft.sealed = data;
              return data;
            },
          },
          documentFile: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
              const row = { id: `file${draft.documentFiles.length + 1}`, ...data };
              draft.documentFiles.push(row);
              return row;
            },
          },
        };
        const result = await fn(tx, async (event) => {
          if (db.state.failRecord) throw new Error('audit insert failed');
          draft.events.push(event);
        });
        Object.assign(db.state, draft);
        return result;
      });
      lock = run.catch(() => undefined);
      return run;
    },
  };
});

import { persistSealedEnvelope, type SealedBuild } from './seal';

function build(content: string): SealedBuild {
  return {
    envelopeId: 'env1', orgId: 'org1', bytes: Buffer.from(`%PDF-${content}`), sha256: content.padEnd(64, '0'),
    manifest: { content }, manifestSignature: 'sig', chainHeadHash: '0'.repeat(64), signedByKeyId: 'k1',
    sourceDocumentCount: 1, recipients: [],
  };
}

const orgDir = join(sealedDir, 'org1');
const finalPath = join(orgDir, 'env1.pdf');
const leftovers = () => (existsSync(orgDir) ? readdirSync(orgDir).filter((f) => f !== 'env1.pdf') : []);

beforeEach(() => {
  rmSync(orgDir, { recursive: true, force: true });
  db.state = { status: 'COMPLETED', documentFiles: [], sealed: null, events: [], failRecord: false };
});

afterAll(() => rmSync(sealedDir, { recursive: true, force: true }));

describe('persistSealedEnvelope', () => {
  it('stores the file, its rows and envelope.sealed once', async () => {
    await expect(persistSealedEnvelope(build('a'))).resolves.toBe('sealed');

    expect(readFileSync(finalPath).toString()).toBe('%PDF-a');
    expect(db.state.documentFiles).toHaveLength(1);
    expect(db.state.documentFiles[0]).toMatchObject({ storagePath: 'org1/env1.pdf', sizeBytes: 6 });
    expect(db.state.sealed).toMatchObject({ envelopeId: 'env1', documentFileId: 'file1', manifestJson: { content: 'a' } });
    expect(db.state.events.map((e) => e.type)).toEqual(['envelope.sealed']);
    expect(leftovers()).toEqual([]);
  });

  it('lets exactly one of two concurrent attempts store the seal, and keeps its file', async () => {
    const outcomes = await Promise.all([persistSealedEnvelope(build('a')), persistSealedEnvelope(build('b'))]);

    expect([...outcomes].sort()).toEqual(['already_sealed', 'sealed']);
    const winner = outcomes[0] === 'sealed' ? 'a' : 'b';
    expect(readFileSync(finalPath).toString()).toBe(`%PDF-${winner}`);
    expect(db.state.sealed).toMatchObject({ manifestJson: { content: winner } });
    expect(db.state.documentFiles).toHaveLength(1);
    expect(db.state.events).toHaveLength(1);
    expect(leftovers()).toEqual([]);
  });

  it('does not touch the stored file when the envelope is already sealed', async () => {
    await persistSealedEnvelope(build('a'));

    await expect(persistSealedEnvelope(build('b'))).resolves.toBe('already_sealed');

    expect(readFileSync(finalPath).toString()).toBe('%PDF-a');
    expect(db.state.events).toHaveLength(1);
    expect(leftovers()).toEqual([]);
  });

  it('stores nothing for an envelope that is not COMPLETED', async () => {
    db.state.status = 'IN_PROGRESS';

    await expect(persistSealedEnvelope(build('a'))).resolves.toBe('not_completed');

    expect(existsSync(finalPath)).toBe(false);
    expect(db.state.sealed).toBeNull();
    expect(leftovers()).toEqual([]);
  });

  it('leaves no file and no rows when the transaction fails', async () => {
    db.state.failRecord = true;

    await expect(persistSealedEnvelope(build('a'))).rejects.toThrow(/audit insert failed/);

    expect(existsSync(finalPath)).toBe(false);
    expect(db.state.sealed).toBeNull();
    expect(db.state.documentFiles).toHaveLength(0);
    expect(leftovers()).toEqual([]);
  });
});
