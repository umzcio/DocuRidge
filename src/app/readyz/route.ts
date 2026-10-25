import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isPdfWorkerAvailable } from '@/lib/pdf-worker/runner';

/**
 * Readiness: process up, DB reachable, and the PDF worker bundle present
 * (without it every upload and seal fails). 503 if either check fails. The
 * worker check is existence tests only; nothing is spawned per probe.
 */
export async function GET() {
  const pdfWorker = isPdfWorkerAvailable() ? 'ok' : 'missing';
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
  if (pdfWorker !== 'ok') errors.push('pdf worker entry not found (pdf-worker.cjs)');
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
