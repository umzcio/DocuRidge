import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

const mocks = vi.hoisted(() => ({
  sources: new Map<string, Buffer>(),
  reads: vi.fn(),
  /** When set, replaces the worker for one call kind of failure. */
  workerFailure: undefined as undefined | (() => unknown),
  jobs: vi.fn(),
}));
vi.mock('../storage', async (importActual) => ({
  ...(await importActual<typeof import('../storage')>()),
  readPdfFromStorage: async (path: string) => {
    mocks.reads(path);
    const bytes = mocks.sources.get(path);
    if (!bytes) throw new Error(`ENOENT: ${path}`);
    return bytes;
  },
}));
vi.mock('../pdf-worker/runner', async (importActual) => {
  const actual = await importActual<typeof import('../pdf-worker/runner')>();
  return {
    ...actual,
    runPdfJob: (...args: Parameters<typeof actual.runPdfJob>) => {
      mocks.jobs(args[0], args[1]);
      if (mocks.workerFailure) return Promise.resolve(mocks.workerFailure());
      return actual.runPdfJob(...args);
    },
  };
});

import { EnvelopeNotSealableError, assertEnvelopeItemsSealable, clearSealCostCache } from './envelope-seal-check';
import { PdfWorkerError } from '../pdf-worker/runner';
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
  mocks.jobs.mockClear();
  mocks.workerFailure = undefined;
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
    expect((err as Error).message).toBe(
      '"Big.pdf" is too large or complex to seal. Replace it with a re-saved or printed-to-PDF copy before sending.',
    );
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

  it('measures again when the parse-object ceiling changes', async () => {
    mocks.sources.set('org/a.pdf', await pagesPdf(1));

    await assertEnvelopeItemsSealable([item('A', 'org/a.pdf')]);
    vi.stubEnv('PDF_MAX_PARSE_OBJECTS', '5');
    await expect(assertEnvelopeItemsSealable([item('A', 'org/a.pdf')])).rejects.toThrow(/too large or complex/);
    expect(mocks.reads).toHaveBeenCalledTimes(2);
  });

  it('shares its cache between two instances of the module', async () => {
    mocks.sources.set('org/a.pdf', await pagesPdf(1));
    vi.resetModules();
    const other = await import('./envelope-seal-check');
    expect(other.assertEnvelopeItemsSealable).not.toBe(assertEnvelopeItemsSealable);

    await other.assertEnvelopeItemsSealable([item('A', 'org/a.pdf')]);
    await assertEnvelopeItemsSealable([item('A', 'org/a.pdf')]);
    expect(mocks.reads).toHaveBeenCalledTimes(1);
  });
});

describe('worker-backed measurement', () => {
  const failWith = (reason: 'busy' | 'timeout' | 'unavailable') => () => {
    throw new PdfWorkerError(reason, reason);
  };

  it('a busy worker refuses the send without caching the result', async () => {
    mocks.sources.set('org/a.pdf', await pagesPdf(1));
    mocks.workerFailure = failWith('busy');

    await expect(assertEnvelopeItemsSealable([item('A', 'org/a.pdf')])).rejects.toThrow(
      'DocuRidge is busy processing other documents. Try sending again in a minute.',
    );
    await expect(assertEnvelopeItemsSealable([item('A', 'org/a.pdf')])).rejects.toBeInstanceOf(
      EnvelopeNotSealableError,
    );
    expect(mocks.jobs).toHaveBeenCalledTimes(2);

    mocks.workerFailure = undefined;
    await expect(assertEnvelopeItemsSealable([item('A', 'org/a.pdf')])).resolves.toHaveLength(1);
    expect(mocks.jobs).toHaveBeenCalledTimes(3);
  });

  it('a worker timeout is cached as too complex', async () => {
    mocks.sources.set('org/a.pdf', await pagesPdf(1));
    mocks.workerFailure = failWith('timeout');

    await expect(assertEnvelopeItemsSealable([item('A', 'org/a.pdf')])).rejects.toThrow(
      /"A" is too large or complex to seal/,
    );
    await expect(assertEnvelopeItemsSealable([item('A', 'org/a.pdf')])).rejects.toThrow(/too large or complex/);
    expect(mocks.jobs).toHaveBeenCalledTimes(1);
  });

  it('a forged worker cost is refused as too complex, and that refusal is cached', async () => {
    mocks.sources.set('org/a.pdf', await pagesPdf(1));
    mocks.workerFailure = () => ({ ok: true, pageCount: 5, sealCost: { pages: 1, objects: 1, bytes: 1 } });

    await expect(assertEnvelopeItemsSealable([item('A', 'org/a.pdf')])).rejects.toThrow(/too large or complex/);
    await expect(assertEnvelopeItemsSealable([item('A', 'org/a.pdf')])).rejects.toThrow(/too large or complex/);
    expect(mocks.jobs).toHaveBeenCalledTimes(1);
  });

  it('a crashed worker is unreadable and not cached', async () => {
    mocks.sources.set('org/a.pdf', await pagesPdf(1));
    mocks.workerFailure = () => {
      throw new PdfWorkerError('crashed', 'crashed');
    };

    await expect(assertEnvelopeItemsSealable([item('A', 'org/a.pdf')])).rejects.toThrow(/"A" could not be read/);
    await expect(assertEnvelopeItemsSealable([item('A', 'org/a.pdf')])).rejects.toThrow(/could not be read/);
    expect(mocks.jobs).toHaveBeenCalledTimes(2);
  });

  it('a job failure is unreadable, not cached, and never shows the child\'s text', async () => {
    mocks.sources.set('org/a.pdf', await pagesPdf(1));
    mocks.workerFailure = () => {
      throw new Error('child text at /app/pdf-worker.cjs');
    };

    for (let i = 0; i < 2; i++) {
      const err = await assertEnvelopeItemsSealable([item('A', 'org/a.pdf')]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EnvelopeNotSealableError);
      expect((err as Error).message).toBe('"A" could not be read, so it could not be sealed. Replace it before sending.');
    }
    expect(mocks.jobs).toHaveBeenCalledTimes(2);
  });

  it('marks only the busy refusal retryable', async () => {
    mocks.sources.set('org/a.pdf', await pagesPdf(1));
    mocks.workerFailure = failWith('busy');
    const busy = await assertEnvelopeItemsSealable([item('A', 'org/a.pdf')]).catch((e: unknown) => e);
    expect((busy as EnvelopeNotSealableError).retryable).toBe(true);

    mocks.workerFailure = failWith('timeout');
    const tooComplex = await assertEnvelopeItemsSealable([item('A', 'org/a.pdf')]).catch((e: unknown) => e);
    expect((tooComplex as EnvelopeNotSealableError).retryable).toBe(false);
  });

  it('an unavailable worker gives the busy message and is not cached', async () => {
    mocks.sources.set('org/a.pdf', await pagesPdf(1));
    mocks.workerFailure = failWith('unavailable');

    for (let i = 0; i < 2; i++) {
      await expect(assertEnvelopeItemsSealable([item('A', 'org/a.pdf')])).rejects.toThrow(
        'DocuRidge is busy processing other documents. Try sending again in a minute.',
      );
    }
    expect(mocks.jobs).toHaveBeenCalledTimes(2);
  });

  it('asks the worker to ignore encryption, as the old send-time load did', async () => {
    mocks.sources.set('org/a.pdf', await pagesPdf(1));
    await assertEnvelopeItemsSealable([item('A', 'org/a.pdf')]);
    expect(mocks.jobs).toHaveBeenCalledWith('inspect', expect.objectContaining({ ignoreEncryption: true }));
  });
});
