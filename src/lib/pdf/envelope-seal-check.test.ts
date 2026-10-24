import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

const mocks = vi.hoisted(() => ({
  sources: new Map<string, Buffer>(),
  reads: vi.fn(),
}));
vi.mock('../storage', () => ({
  readPdfFromStorage: async (path: string) => {
    mocks.reads(path);
    const bytes = mocks.sources.get(path);
    if (!bytes) throw new Error(`ENOENT: ${path}`);
    return bytes;
  },
}));

import { EnvelopeNotSealableError, assertEnvelopeItemsSealable, clearSealCostCache } from './envelope-seal-check';
import { sharedKidsFormPdf } from './__fixtures__/hostile-form-pdf';

async function pagesPdf(count: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([612, 792]).drawText(`page ${i + 1}`, { x: 50, y: 700 });
  return Buffer.from(await doc.save());
}

const item = (title: string, storagePath: string) => ({ title, documentFile: { storagePath } });

beforeEach(() => {
  vi.unstubAllEnvs();
  mocks.sources.clear();
  mocks.reads.mockClear();
  clearSealCostCache();
});

describe('assertEnvelopeItemsSealable', () => {
  it('accepts documents within every per-document cap and reports their cost', async () => {
    mocks.sources.set('org/a.pdf', await pagesPdf(2));
    mocks.sources.set('org/b.pdf', await pagesPdf(3));

    const costs = await assertEnvelopeItemsSealable([item('A', 'org/a.pdf'), item('B', 'org/b.pdf')]);

    expect(costs.map((c) => c.pages)).toEqual([2, 3]);
  });

  it('refuses a document over a per-document cap, naming it', async () => {
    vi.stubEnv('PDF_MAX_PAGES', '2');
    mocks.sources.set('org/a.pdf', await pagesPdf(1));
    mocks.sources.set('org/big.pdf', await pagesPdf(3));

    const err = await assertEnvelopeItemsSealable([item('A', 'org/a.pdf'), item('Big.pdf', 'org/big.pdf')])
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EnvelopeNotSealableError);
    expect((err as Error).message).toMatch(/"Big\.pdf" is too large or complex to seal/);
    expect((err as Error).message).toMatch(/more than 2 pages/);
  });

  it('refuses a form that sealing could not flatten within its caps', async () => {
    mocks.sources.set('org/form.pdf', await sharedKidsFormPdf(24));

    await expect(assertEnvelopeItemsSealable([item('Form', 'org/form.pdf')]))
      .rejects.toThrow(/"Form" is too large or complex to seal/);
  });

  it('refuses a document that cannot be read, without leaking its storage path', async () => {
    const err = await assertEnvelopeItemsSealable([item('Gone', 'org/missing.pdf')]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EnvelopeNotSealableError);
    expect((err as Error).message).toMatch(/"Gone" could not be read/);
    expect((err as Error).message).not.toMatch(/org\/missing/);
  });

  it('refuses more documents than the envelope item cap', async () => {
    vi.stubEnv('PDF_MAX_ENVELOPE_ITEMS', '2');
    mocks.sources.set('org/a.pdf', await pagesPdf(1));

    await expect(assertEnvelopeItemsSealable([item('A', 'org/a.pdf'), item('B', 'org/a.pdf'), item('C', 'org/a.pdf')]))
      .rejects.toThrow(/more than 2 documents/);
    expect(mocks.reads).not.toHaveBeenCalled();
  });

  it('refuses documents that each fit but together exceed the envelope totals', async () => {
    vi.stubEnv('PDF_MAX_ENVELOPE_PAGES', '4');
    mocks.sources.set('org/a.pdf', await pagesPdf(3));
    mocks.sources.set('org/b.pdf', await pagesPdf(2));

    const err = await assertEnvelopeItemsSealable([item('A', 'org/a.pdf'), item('B', 'org/b.pdf')])
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EnvelopeNotSealableError);
    expect((err as Error).message).toMatch(/more than 4 pages in total/);
  });

  it('measures each stored document once while the caps are unchanged', async () => {
    mocks.sources.set('org/a.pdf', await pagesPdf(1));

    await assertEnvelopeItemsSealable([item('A', 'org/a.pdf')]);
    await assertEnvelopeItemsSealable([item('A again', 'org/a.pdf')]);
    expect(mocks.reads).toHaveBeenCalledTimes(1);

    vi.stubEnv('PDF_MAX_PAGES', '1');
    await assertEnvelopeItemsSealable([item('A', 'org/a.pdf')]);
    expect(mocks.reads).toHaveBeenCalledTimes(2);
  });
});
