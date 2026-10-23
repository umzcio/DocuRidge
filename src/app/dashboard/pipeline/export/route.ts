import { NextRequest, NextResponse } from 'next/server';
import { redirectTo } from '@/lib/request-origin';
import { getSession } from '@/lib/auth/session';
import { authorize } from '@/lib/authz/can';
import { getBasePath } from '@/lib/env';
import { pipelineQuery, toCsv } from '../query';

export const dynamic = 'force-dynamic';

/**
 * CSV export of the contract pipeline — same org-scoped query as the table,
 * so the download always matches what's on screen (plus signer emails).
 * Auth-gated identically to the dashboard page itself.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return redirectTo(req, `${getBasePath()}/login`);
  }
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };
  authorize(ctx, 'envelope:read');

  const sp = req.nextUrl.searchParams;
  const { rows } = await pipelineQuery(ctx.orgId, {
    status: sp.get('status') ?? '',
    sender: sp.get('sender') ?? '',
    from: sp.get('from') ?? '',
    to: sp.get('to') ?? '',
    all: true,
  });

  return new NextResponse(toCsv(rows), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="pipeline.csv"',
      'cache-control': 'private, no-cache, no-store, must-revalidate',
    },
  });
}
