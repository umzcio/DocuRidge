import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { optionalContentPdf } from '../pdf/__fixtures__/policy-pdfs';

const mocks = vi.hoisted(() => ({
  uploadsDir: '',
  template: null as unknown as Record<string, unknown>,
  rows: new Map<string, Record<string, unknown>>(),
  transaction: vi.fn(),
}));

vi.mock('../prisma', () => ({
  prisma: {
    envelope: { findFirst: async () => mocks.template },
    documentFile: {
      findUnique: async ({ where }: { where: { id: string } }) => structuredClone(mocks.rows.get(where.id) ?? null),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = mocks.rows.get(where.id as string);
        if (!row || !Object.entries(where).every(([k, v]) => row[k] === v)) return { count: 0 };
        Object.assign(row, structuredClone(data));
        return { count: 1 };
      },
    },
    $transaction: mocks.transaction,
  },
}));
vi.mock('../env', () => ({ getEnv: () => ({ UPLOADS_DIR: mocks.uploadsDir }) }));
vi.mock('../audit/envelope', () => ({ recordEnvelopeEvent: vi.fn() }));

import { instantiateTemplate } from './service';
import { EnvelopeNotSealableError } from '../pdf/envelope-seal-check';

const ctx = { userId: 'u1', orgId: 'org1', role: 'ADMIN' as const };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.uploadsDir ||= mkdtempSync(join(tmpdir(), 'docuridge-template-test-'));
  mocks.rows.clear();
});

afterAll(() => {
  rmSync(mocks.uploadsDir, { recursive: true, force: true });
});

describe('instantiateTemplate', () => {
  it('instantiating a template whose document has hidden layers is refused before any envelope is sent', async () => {
    // A template document stored before canonical copies existed.
    const { doc } = await optionalContentPdf('off');
    const bytes = await doc.save();
    const hash = createHash('sha256').update(bytes).digest('hex');
    mkdirSync(join(mocks.uploadsDir, 'org1'), { recursive: true });
    writeFileSync(join(mocks.uploadsDir, 'org1', `${hash}.pdf`), bytes);
    mocks.rows.set('df1', {
      id: 'df1', orgId: 'org1', storagePath: `org1/${hash}.pdf`,
      canonicalStoragePath: null, canonicalSha256: null, canonicalVersion: null,
      canonicalPageCount: null, canonicalSealCost: null, canonicalRefusal: null,
    });
    mocks.template = {
      id: 'tpl1', orgId: 'org1', type: 'TEMPLATE', title: 'Contract template',
      items: [{ id: 'i1', order: 1, title: 'Contract.pdf', pageCount: 1, documentFileId: 'df1' }],
      recipients: [], fields: [],
    };

    const err = await instantiateTemplate({ ctx, templateId: 'tpl1', roleMappings: {} }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EnvelopeNotSealableError);
    expect((err as Error).message).toMatch(/^"Contract\.pdf" can't be sent: This PDF has hidden layers/);
    expect(mocks.rows.get('df1')!.canonicalRefusal).toBe('hidden_layers');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
