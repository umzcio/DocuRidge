import { NextResponse } from 'next/server';

/** Liveness: is the process running? Always 200 when reachable. */
export async function GET() {
  return NextResponse.json({ status: 'ok', service: 'docuridge' }, { status: 200 });
}
