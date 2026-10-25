import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfComplexityError } from '../pdf/seal-limits';
import { PdfDecodeLimitError } from '../pdf/decode-limits';
import { SealedContentStructureError } from '../pdf/page-tree';

const logs = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../logger', () => ({
  getLogger: () => ({ warn: logs.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { PdfWorkerError, reviveError } from './errors';
import { serializeError } from './protocol';
import { pdfWorkerChildEnv, runPdfJob } from './runner';

const SAVED_ENV = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED_ENV)) delete process.env[key];
  }
  Object.assign(process.env, SAVED_ENV);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the job to reject');
}

async function workerReason(promise: Promise<unknown>): Promise<string> {
  const err = await rejection(promise);
  expect(err).toBeInstanceOf(PdfWorkerError);
  return (err as PdfWorkerError).reason;
}

/** Linux: the pids of this process's live children, read from /proc. */
function childPids(): number[] {
  const pids: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      // pid (comm) state ppid ... ; comm may contain spaces, so split after ')'.
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid === process.pid) pids.push(Number(name));
    } catch {
      // the process exited while we were listing
    }
  }
  return pids;
}

afterAll(restoreEnv);

describe('runPdfJob in process mode', () => {
  beforeEach(() => {
    restoreEnv();
    process.env.PDF_WORKER_MODE = 'process';
    process.env.PDF_WORKER_DIAGNOSTICS = '1';
    logs.warn.mockClear();
  });
  afterEach(restoreEnv);

  it('round-trips a 25 MB buffer', async () => {
    const bytes = new Uint8Array(25 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 4093) bytes[i] = i % 251;
    bytes[bytes.length - 1] = 7;
    const started = Date.now();
    const out = await runPdfJob('diagnostic', { op: 'echo', bytes });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out.bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(out.bytes!).equals(Buffer.from(bytes))).toBe(true);
  }, 20_000);

  it('kills a job at its time limit', async () => {
    let ticks = 0;
    let last = Date.now();
    let maxGap = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks++;
    }, 10);
    try {
      const started = Date.now();
      const reason = await workerReason(runPdfJob('diagnostic', { op: 'spin' }, { timeoutMs: 1000 }));
      const elapsed = Date.now() - started;
      expect(reason).toBe('timeout');
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(2500);
      // The parent's event loop kept running while the child spun.
      expect(ticks).toBeGreaterThanOrEqual(20);
      expect(maxGap).toBeLessThan(500);
    } finally {
      clearInterval(timer);
    }
  }, 10_000);

  it('reports out of memory', async () => {
    // The cap leaves room to start the child, so the OOM below is the job's.
    expect((await runPdfJob('diagnostic', { op: 'pid' }, { heapMb: 64 })).pid).toEqual(expect.any(Number));
    const reason = await workerReason(runPdfJob('diagnostic', { op: 'allocate' }, { heapMb: 64 }));
    expect(reason).toBe('out_of_memory');
    expect(logs.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'out_of_memory', stderrTail: expect.stringMatching(/heap/i) }),
      'PDF worker job failed',
    );
  }, 20_000);

  it('reports a crash', async () => {
    const reason = await workerReason(runPdfJob('diagnostic', { op: 'exit', code: 3 }));
    expect(reason).toBe('crashed');
  }, 10_000);

  it('never passes secrets', async () => {
    process.env.DATABASE_URL = 'postgresql://user:pw@db:5432/x';
    process.env.SESSION_SECRET = 'session-secret-value';
    process.env.JWS_SIGNING_TOKEN_SECRET = 'jws-secret-value';
    process.env.KEYS_DIR = '/data/keys';
    process.env.PDF_MAX_PAGES = '1234';
    process.env.ENVELOPE_MAX_FIELDS = '77';
    const out = await runPdfJob('diagnostic', { op: 'env' });
    const env = out.env!;
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(env.JWS_SIGNING_TOKEN_SECRET).toBeUndefined();
    expect(env.KEYS_DIR).toBeUndefined();
    expect(env.PDF_MAX_PAGES).toBe('1234');
    expect(env.ENVELOPE_MAX_FIELDS).toBe('77');
    const values = Object.values(env).join('\n');
    expect(values).not.toContain('session-secret-value');
    expect(values).not.toContain('jws-secret-value');
  }, 10_000);

  it('uses a fresh process per job', async () => {
    const a = await runPdfJob('diagnostic', { op: 'pid' });
    const b = await runPdfJob('diagnostic', { op: 'pid' });
    expect(a.pid).toEqual(expect.any(Number));
    expect(b.pid).toEqual(expect.any(Number));
    expect(a.pid).not.toBe(b.pid);
    expect(a.pid).not.toBe(process.pid);
  }, 10_000);

  it('answers child requests', async () => {
    const out = await runPdfJob('diagnostic', { op: 'ask', question: 'hi' }, {
      onRequest: async (q) => `${String(q)}!`,
    });
    expect(out.answer).toBe('hi!');
  }, 10_000);

  it('passes an onRequest failure back to the child as an error', async () => {
    const err = await rejection(
      runPdfJob('diagnostic', { op: 'ask', question: 'hi' }, {
        onRequest: async () => {
          throw new Error('parent refused');
        },
      }),
    );
    expect(err).not.toBeInstanceOf(PdfWorkerError);
    expect((err as Error).message).toBe('parent refused');
  }, 10_000);

  it.skipIf(process.platform !== 'linux')('rejects crashed when the child dies while a request is pending', async () => {
    const before = new Set(childPids());
    const started = Date.now();
    const reason = await workerReason(
      runPdfJob('diagnostic', { op: 'ask', question: 'hi' }, {
        timeoutMs: 15_000,
        onRequest: () => {
          for (const pid of childPids()) if (!before.has(pid)) process.kill(pid, 'SIGKILL');
          return new Promise(() => {}); // never answers
        },
      }),
    );
    expect(reason).toBe('crashed');
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('queues beyond concurrency and refuses after the queue limit', async () => {
    process.env.PDF_WORKER_CONCURRENCY = '1';
    process.env.PDF_WORKER_QUEUE_MS = '300';
    const spin = runPdfJob('diagnostic', { op: 'spin' }, { timeoutMs: 1000 });
    const second = runPdfJob('diagnostic', { op: 'pid' });
    const started = Date.now();
    expect(await workerReason(second)).toBe('busy');
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(1000);
    expect(await workerReason(spin)).toBe('timeout');
  }, 10_000);

  it('admits a queued job once a slot frees', async () => {
    process.env.PDF_WORKER_CONCURRENCY = '1';
    process.env.PDF_WORKER_QUEUE_MS = '10000';
    const first = runPdfJob('diagnostic', { op: 'pid' });
    const second = runPdfJob('diagnostic', { op: 'pid' });
    const [a, b] = await Promise.all([first, second]);
    expect(a.pid).not.toBe(b.pid);
  }, 15_000);

  it('rejects unavailable when the worker entry cannot be found', async () => {
    process.env.PDF_WORKER_ENTRY = '/nonexistent/pdf-worker.cjs';
    expect(await workerReason(runPdfJob('diagnostic', { op: 'pid' }))).toBe('unavailable');
  });

  it('rejects a kind with no registered handler', async () => {
    delete process.env.PDF_WORKER_DIAGNOSTICS;
    const err = await rejection(runPdfJob('diagnostic', { op: 'pid' }));
    expect(err).not.toBeInstanceOf(PdfWorkerError);
    expect((err as Error).message).toMatch(/no PDF job handler is registered for "diagnostic"/i);
  }, 10_000);

  it('turns a job error into a plain Error with its message', async () => {
    const err = await rejection(
      runPdfJob('diagnostic', { op: 'echo', bytes: 'not bytes' as unknown as Uint8Array }),
    );
    expect(err).not.toBeInstanceOf(PdfWorkerError);
    expect((err as Error).message).toMatch(/echo needs a Uint8Array/);
  }, 10_000);
});

describe('runPdfJob in inline mode', () => {
  beforeEach(() => {
    restoreEnv();
    process.env.PDF_WORKER_MODE = 'inline';
    process.env.PDF_WORKER_DIAGNOSTICS = '1';
  });
  afterEach(restoreEnv);

  it('runs the handler in this process', async () => {
    const out = await runPdfJob('diagnostic', { op: 'pid' });
    expect(out.pid).toBe(process.pid);
  });

  it('routes child requests to onRequest', async () => {
    const out = await runPdfJob('diagnostic', { op: 'ask', question: 'hi' }, {
      onRequest: async (q) => `${String(q)}!`,
    });
    expect(out.answer).toBe('hi!');
  });

  it('refuses the destructive diagnostics outside a child', async () => {
    const err = await rejection(runPdfJob('diagnostic', { op: 'exit', code: 3 }));
    expect((err as Error).message).toMatch(/only runs in a worker process/);
  });

  it('rejects a kind with no registered handler', async () => {
    const err = await rejection(runPdfJob('seal' as 'diagnostic', { op: 'pid' }));
    expect((err as Error).message).toMatch(/no PDF job handler is registered for "seal"/i);
  });
});

describe('job error serialization', () => {
  it('rebuilds PdfComplexityError with its limit', () => {
    const err = reviveError(serializeError(new PdfComplexityError('parse_objects', 'too many objects')));
    expect(err).toBeInstanceOf(PdfComplexityError);
    expect((err as PdfComplexityError).limit).toBe('parse_objects');
    expect((err as PdfComplexityError).code).toBe('pdf_too_complex');
    expect(err.message).toBe('too many objects');
  });

  it('rebuilds PdfDecodeLimitError with its limit', () => {
    const original = new PdfDecodeLimitError('total', 1024);
    const err = reviveError(serializeError(original));
    expect(err).toBeInstanceOf(PdfDecodeLimitError);
    expect((err as PdfDecodeLimitError).limit).toBe('total');
    expect((err as PdfDecodeLimitError).limitBytes).toBe(1024);
    expect(err.message).toBe(original.message);
  });

  it('rebuilds SealedContentStructureError with its code', () => {
    const err = reviveError(serializeError(new SealedContentStructureError('bad tree')));
    expect(err).toBeInstanceOf(SealedContentStructureError);
    expect((err as SealedContentStructureError).code).toBe('sealed_content_page_tree');
    expect(err.message).toBe('bad tree');
  });

  it('turns anything else into a plain Error', () => {
    class Custom extends Error {
      code = 'custom';
    }
    const err = reviveError(serializeError(new Custom('boom')));
    expect(err.constructor).toBe(Error);
    expect(err.message).toBe('boom');
    expect(reviveError(serializeError('a string')).message).toBe('a string');
  });
});

describe('pdfWorkerChildEnv', () => {
  it('keeps only the allowlist', () => {
    const env = pdfWorkerChildEnv({
      NODE_ENV: 'production',
      TZ: 'UTC',
      PATH: '/usr/bin',
      HOME: '/home/x',
      DATABASE_URL: 'postgresql://x',
      PDF_MAX_PAGES: '10',
      PDF_WORKER_DIAGNOSTICS: '1',
      MAX_IMAGE_DIMENSION: '1',
      MAX_IMAGE_PIXELS: '2',
      MAX_SIGNATURE_IMAGE_BYTES: '3',
      SEAL_MAX_IMAGE_PIXELS: '4',
      ENVELOPE_MAX_FIELDS: '5',
      ENVELOPE_MAX_FIELDS_PER_PAGE: '6',
      MAX_UPLOAD_BYTES: '7',
      NODE_OPTIONS: '--require /evil.js',
    });
    expect(Object.keys(env).sort()).toEqual(
      [
        'ENVELOPE_MAX_FIELDS',
        'ENVELOPE_MAX_FIELDS_PER_PAGE',
        'MAX_IMAGE_DIMENSION',
        'MAX_IMAGE_PIXELS',
        'MAX_SIGNATURE_IMAGE_BYTES',
        'NODE_ENV',
        'PDF_MAX_PAGES',
        'PDF_WORKER_DIAGNOSTICS',
        'SEAL_MAX_IMAGE_PIXELS',
        'TZ',
      ].sort(),
    );
  });
});
