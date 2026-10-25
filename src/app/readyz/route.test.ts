import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  resolvePdfWorkerEntry: vi.fn(),
  runPdfJob: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: { $queryRaw: mocks.queryRaw } }));
vi.mock('@/lib/pdf-worker/entry', () => ({ resolvePdfWorkerEntry: mocks.resolvePdfWorkerEntry }));
vi.mock('@/lib/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.logError, debug: vi.fn() }),
}));
vi.mock('@/lib/pdf-worker/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pdf-worker/runner')>()),
  runPdfJob: mocks.runPdfJob,
}));

import { GET } from './route';
import { PDF_WORKER_SMOKE_RETRY_MS, pdfWorkerSmokeTest, resetPdfWorkerSmokeTest } from '@/lib/pdf-worker/smoke';
import { PdfWorkerError } from '@/lib/pdf-worker/errors';

describe('GET /readyz', () => {
  beforeEach(() => {
    resetPdfWorkerSmokeTest();
    mocks.logError.mockReset();
    mocks.queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);
    mocks.resolvePdfWorkerEntry.mockReset().mockReturnValue({ file: '/app/pdf-worker.cjs', execArgv: [], sandboxed: true });
    mocks.runPdfJob.mockReset().mockResolvedValue('pong');
  });

  it('is ready when the database answers and the pdf worker runs a job', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready', database: 'ok', pdfWorker: 'ok' });
    expect(mocks.runPdfJob).toHaveBeenCalledWith('ping', {}, expect.any(Object));
  });

  it('is not ready when the pdf worker entry cannot be resolved', async () => {
    mocks.resolvePdfWorkerEntry.mockReturnValue(null);
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'not_ready', database: 'ok', pdfWorker: 'missing' });
    expect(JSON.stringify(body).toLowerCase()).toContain('pdf worker');
    expect(mocks.runPdfJob).not.toHaveBeenCalled();
  });

  it('is not ready when the database is unreachable', async () => {
    mocks.queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'not_ready', database: 'unreachable', pdfWorker: 'ok' });
  });

  it('reports failed and 503 when the smoke job fails', async () => {
    mocks.runPdfJob.mockRejectedValue(new PdfWorkerError('unavailable', 'The PDF worker could not be started'));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'not_ready', database: 'ok', pdfWorker: 'failed' });
    expect(mocks.logError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'unavailable' }), 'PDF worker smoke test failed');
  });

  it('reports failed when the smoke job answers anything but pong', async () => {
    mocks.runPdfJob.mockResolvedValue('ping');
    expect((await GET()).status).toBe(503);
  });

  it('runs the smoke job once and reuses a success for later probes', async () => {
    for (let i = 0; i < 3; i++) expect((await GET()).status).toBe(200);
    expect(mocks.runPdfJob).toHaveBeenCalledTimes(1);
  });

  it('shares one smoke job between concurrent probes', async () => {
    const statuses = await Promise.all([GET(), GET(), GET()]);
    expect(statuses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(mocks.runPdfJob).toHaveBeenCalledTimes(1);
  });

  it('a busy worker is inconclusive: ready, and not cached', async () => {
    mocks.runPdfJob.mockRejectedValueOnce(new PdfWorkerError('busy'));
    expect((await GET()).status).toBe(200);
    expect((await GET()).status).toBe(200);
    expect(mocks.runPdfJob).toHaveBeenCalledTimes(2);
  });
});

describe('pdfWorkerSmokeTest caching', () => {
  beforeEach(() => {
    resetPdfWorkerSmokeTest();
    mocks.runPdfJob.mockReset();
  });

  it('reuses a failure for a minute, then runs the job again', async () => {
    let now = 1_000_000;
    const clock = () => now;
    mocks.runPdfJob.mockRejectedValue(new PdfWorkerError('crashed'));

    expect(await pdfWorkerSmokeTest(clock)).toBe('failed');
    now += PDF_WORKER_SMOKE_RETRY_MS - 1;
    expect(await pdfWorkerSmokeTest(clock)).toBe('failed');
    expect(mocks.runPdfJob).toHaveBeenCalledTimes(1);

    mocks.runPdfJob.mockResolvedValue('pong');
    now += 1;
    expect(await pdfWorkerSmokeTest(clock)).toBe('ok');
    expect(mocks.runPdfJob).toHaveBeenCalledTimes(2);

    now += 10 * PDF_WORKER_SMOKE_RETRY_MS;
    expect(await pdfWorkerSmokeTest(clock)).toBe('ok');
    expect(mocks.runPdfJob).toHaveBeenCalledTimes(2);
  });
});
