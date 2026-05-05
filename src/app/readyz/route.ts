import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/** Readiness: process up + DB reachable. 503 if DB connectivity fails. */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json(
      { status: 'ready', database: 'ok' },
      { status: 200 },
    );
  } catch (err) {
    return NextResponse.json(
      {
        status: 'not_ready',
        database: 'unreachable',
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
}
