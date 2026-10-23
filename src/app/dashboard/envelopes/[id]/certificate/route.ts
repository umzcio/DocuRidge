import { NextRequest, NextResponse } from 'next/server';
import { redirectTo } from '@/lib/request-origin';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { authorize } from '@/lib/authz/can';
import { recordEnvelopeEvent } from '@/lib/audit/envelope';
import { buildCompletionCertificate } from '@/lib/completion-certificate';
import { childLogger } from '@/lib/logger';
import { getClientIp } from '@/lib/util';

/**
 * Download the completion package certificate: a one-page, human-readable
 * PDF summarizing the completed signing ceremony (envelope metadata,
 * recipient outcomes, audit-chain digest, offline verify instructions).
 * Available for COMPLETED envelopes only. Auth and authorization mirror the
 * sibling sealed/route.ts and audit.json/route.ts.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return redirectTo(req, '/DocuRidge/login');
  const { id } = await params;
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };

  const env = await prisma.envelope.findFirst({
    where: { id, orgId: ctx.orgId, deletedAt: null },
    include: {
      recipients: { orderBy: { signingOrder: 'asc' } },
      createdBy: { select: { name: true, email: true } },
    },
  });
  if (!env) return new NextResponse('Not found', { status: 404 });
  if (env.status !== 'COMPLETED') {
    return new NextResponse('Certificate is only available for completed envelopes', { status: 404 });
  }
  authorize(ctx, 'envelope:download_sealed', { orgId: env.orgId, createdById: env.createdById });

  const head = await prisma.auditEvent.findFirst({
    where: { envelopeId: env.id },
    orderBy: { seq: 'desc' },
    select: { eventHash: true },
  });

  const bytes = await buildCompletionCertificate({
    envelopeTitle: env.title,
    completedAt: env.completedAt ?? new Date(),
    senderName: env.createdBy?.name ?? env.createdBy?.email ?? '(unknown)',
    recipients: env.recipients.map((r) => ({
      name: r.name,
      email: r.email,
      signedAt: r.signedAt,
      declinedAt: r.declinedAt,
      ipAddress: r.ipAddress,
    })),
    auditChainHash: head?.eventHash ?? '',
    verifyInstructions:
      'The sealed PDF for this envelope re-verifies offline, forever. Run: npm run verify -- <sealed.pdf> ' +
      'to recompute the audit chain and confirm the embedded manifest signature against the org public key.',
  });

  await recordEnvelopeEvent({
    envelopeId: env.id,
    type: 'envelope.downloaded',
    actorUserId: ctx.userId,
    ipAddress: getClientIp(req.headers),
    userAgent: req.headers.get('user-agent') ?? 'unknown',
    data: { artifact: 'completion_certificate' },
  });
  childLogger({ route: 'envelope-certificate' }).info(
    { envelopeId: env.id, userId: ctx.userId },
    'completion certificate downloaded',
  );

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="completion-certificate.pdf"',
      'cache-control': 'private, no-cache, no-store, must-revalidate',
    },
  });
}
