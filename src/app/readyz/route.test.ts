import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  resolvePdfWorkerEntry: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: { $queryRaw: mocks.queryRaw } }));
vi.mock('@/lib/pdf-worker/entry', () => ({ resolvePdfWorkerEntry: mocks.resolvePdfWorkerEntry }));

import { GET } from './route';

describe('GET /readyz', () => {
  beforeEach(() => {
    mocks.queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);
    mocks.resolvePdfWorkerEntry.mockReset().mockReturnValue({ file: '/app/pdf-worker.cjs', execArgv: [] });
  });

  it('is ready when the database answers and the pdf worker is present', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready', database: 'ok', pdfWorker: 'ok' });
  });

  it('is not ready when the pdf worker entry cannot be resolved', async () => {
    mocks.resolvePdfWorkerEntry.mockReturnValue(null);
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'not_ready', database: 'ok', pdfWorker: 'missing' });
    expect(JSON.stringify(body).toLowerCase()).toContain('pdf worker');
  });

  it('is not ready when the database is unreachable', async () => {
    mocks.queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'not_ready', database: 'unreachable', pdfWorker: 'ok' });
  });
});
