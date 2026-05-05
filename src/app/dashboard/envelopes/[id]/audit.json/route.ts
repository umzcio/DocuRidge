import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { authorize } from '@/lib/authz/can';
import { recordEnvelopeEvent, verifyEnvelopeChain } from '@/lib/audit/envelope';
import { childLogger } from '@/lib/logger';
import { getClientIp } from '@/lib/util';

/**
 * Download the per-envelope audit trail as JSON. Includes the chain head,
 * every event with its prevHash + eventHash + signature placeholders, and
 * the chain-verification result computed at request time.
 */
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
  });
  if (!env) return new NextResponse('Not found', { status: 404 });
  authorize(ctx, 'envelope:audit_view', { orgId: env.orgId, createdById: env.createdById });

  const events = await prisma.auditEvent.findMany({
    where: { envelopeId: env.id },
    orderBy: { seq: 'asc' },
  });
  const recipients = await prisma.recipient.findMany({
    where: { envelopeId: env.id },
    orderBy: { signingOrder: 'asc' },
  });
  const verification = await verifyEnvelopeChain(env.id);

  const payload = {
    version: 1,
    envelope: {
      id: env.id,
      title: env.title,
      orgId: env.orgId,
      status: env.status,
      routingMode: env.routingMode,
      createdAt: env.createdAt.toISOString(),
      sentAt: env.sentAt?.toISOString() ?? null,
      completedAt: env.completedAt?.toISOString() ?? null,
      voidedAt: env.voidedAt?.toISOString() ?? null,
      declinedAt: env.declinedAt?.toISOString() ?? null,
    },
    recipients: recipients.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      signingOrder: r.signingOrder,
      signingStatus: r.signingStatus,
      signedAt: r.signedAt?.toISOString() ?? null,
      declinedAt: r.declinedAt?.toISOString() ?? null,
      ipAddress: r.ipAddress,
      userAgent: r.userAgent,
    })),
    chain: {
      length: events.length,
      head: events[events.length - 1]?.eventHash ?? null,
      verification,
      events: events.map((e) => ({
        seq: e.seq,
        type: e.type,
        createdAt: e.createdAt.toISOString(),
        actor: { userId: e.actorUserId, recipientId: e.actorRecipientId, email: e.actorEmail, name: e.actorName },
        ipAddress: e.ipAddress,
        userAgent: e.userAgent,
        data: e.data,
        prevHash: e.prevHash,
        eventHash: e.eventHash,
        signature: e.signature,
        signedByKeyId: e.signedByKeyId,
      })),
    },
  };

  await recordEnvelopeEvent({
    envelopeId: env.id,
    type: 'envelope.verified',
    actorUserId: ctx.userId,
    ipAddress: getClientIp(req.headers),
    userAgent: req.headers.get('user-agent') ?? 'unknown',
    data: { verification },
  });
  childLogger({ route: 'audit-json' }).info(
    { envelopeId: env.id, userId: ctx.userId, verifyOk: verification.ok },
    'audit JSON downloaded',
  );

  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${escapeFilename(env.title)}.audit.json"`,
      'cache-control': 'private, no-cache, no-store, must-revalidate',
    },
  });
}

function escapeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 80);
}
