import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { authorize } from '@/lib/authz/can';
import { readSealedPdf } from '@/lib/storage';
import { recordEnvelopeEvent } from '@/lib/audit/envelope';
import { childLogger } from '@/lib/logger';
import { getClientIp } from '@/lib/util';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL('/DocuRidge/login', req.url), 302);
  const { id } = await params;
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };

  const env = await prisma.envelope.findFirst({
    where: { id, orgId: ctx.orgId, deletedAt: null },
    include: { sealed: { include: { documentFile: true } } },
  });
  if (!env || !env.sealed) {
    return new NextResponse('Sealed PDF not available', { status: 404 });
  }
  authorize(ctx, 'envelope:download_sealed', { orgId: env.orgId, createdById: env.createdById });

  const buffer = await readSealedPdf(env.sealed.documentFile.storagePath);
  await recordEnvelopeEvent({
    envelopeId: env.id,
    type: 'envelope.downloaded',
    actorUserId: ctx.userId,
    ipAddress: getClientIp(req.headers),
    userAgent: req.headers.get('user-agent') ?? 'unknown',
  });
  childLogger({ route: 'envelope-sealed-download' }).info(
    { envelopeId: env.id, userId: ctx.userId },
    'sealed PDF downloaded',
  );

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${escapeFilename(env.title)}.signed.pdf"`,
      'cache-control': 'private, no-cache, no-store, must-revalidate',
    },
  });
}

function escapeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 80);
}
