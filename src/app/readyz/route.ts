import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isPdfWorkerAvailable } from '@/lib/pdf-worker/runner';
import { pdfWorkerSmokeTest } from '@/lib/pdf-worker/smoke';

/**
 * Readiness: process up, DB reachable, and the PDF worker able to run a job
 * (without it every upload and seal fails). 503 if either check fails.
 *
 * The worker check is an existence test of its entry on every probe, plus a
 * `'ping'` job in a real child the first time (pdf-worker/smoke.ts): cached
 * for the life of the process once it passes, retried at most once a minute
 * while it fails. A worker busy with other jobs counts as up.
 */
export async function GET() {
  let pdfWorker: 'ok' | 'missing' | 'failed' = 'missing';
  if (isPdfWorkerAvailable()) pdfWorker = (await pdfWorkerSmokeTest()) === 'failed' ? 'failed' : 'ok';
  let dbError: string | null = null;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  if (dbError === null && pdfWorker === 'ok') {
    return NextResponse.json({ status: 'ready', database: 'ok', pdfWorker }, { status: 200 });
  }
  const errors: string[] = [];
  if (dbError !== null) errors.push(dbError);
  if (pdfWorker === 'missing') errors.push('pdf worker entry not found (pdf-worker.cjs)');
  if (pdfWorker === 'failed') errors.push('pdf worker smoke test failed (see the server log)');
  return NextResponse.json(
    {
      status: 'not_ready',
      database: dbError === null ? 'ok' : 'unreachable',
      pdfWorker,
      error: errors.join('; '),
    },
    { status: 503 },
  );
}
