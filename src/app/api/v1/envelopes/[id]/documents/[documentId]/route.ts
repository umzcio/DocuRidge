import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guardApiRequest, notFoundJson } from '@/lib/api/guard';
import { resolveApiActor } from '@/lib/api/auth';
import { authorize, AuthorizationError } from '@/lib/authz/can';
import { readPdfFromStorage } from '@/lib/storage';
import { recordEnvelopeEvent } from '@/lib/audit/envelope';
import { getClientIp } from '@/lib/util';
import { childLogger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const MIME_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
};

/**
 * GET /api/v1/envelopes/:id/documents/:documentId — raw file bytes for one
 * envelope document, served with the document's stored content type.
 *
 * Authorization mirrors the sealed-download can semantics: the same
 * `envelope:download_sealed` permission is checked through the centralized
 * `authorize()` matrix, using a synthetic AuthnContext built from the token's
 * creator (userId/orgId + their current org role). Downloads are recorded as
 * `envelope.downloaded` audit events, exactly like the dashboard route.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; documentId: string }> },
) {
  const guard = await guardApiRequest(req, 'read');
  if (!guard.ok) return guard.response;

  const { id, documentId } = await params;
  const env = await prisma.envelope.findFirst({
    where: { id, orgId: guard.auth.token.orgId, deletedAt: null, type: 'DOCUMENT' },
    include: { items: { include: { documentFile: true }, orderBy: { order: 'asc' } } },
  });
  if (!env) return notFoundJson('Envelope not found.');

  const item = env.items.find((i) => i.id === documentId);
  if (!item) return notFoundJson('Document not found.');

  const ctx = await resolveApiActor(guard.auth.token.orgId, guard.auth.token.userId);
  if (!ctx) {
    return NextResponse.json({ error: 'Token creator is no longer a member of this organization.' }, { status: 403 });
  }
  try {
    authorize(ctx, 'envelope:download_sealed', { orgId: env.orgId, createdById: env.createdById });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  const buffer = await readPdfFromStorage(item.documentFile.storagePath);
  await recordEnvelopeEvent({
    envelopeId: env.id,
    type: 'envelope.downloaded',
    actorUserId: ctx.userId,
    ipAddress: getClientIp(req.headers),
    userAgent: req.headers.get('user-agent') ?? 'unknown',
  });
  childLogger({ route: 'api-document-download' }).info(
    { envelopeId: env.id, documentId: item.id, userId: ctx.userId },
    'document downloaded via API',
  );

  const ext = MIME_EXT[item.documentFile.mimeType] ?? '';
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'content-type': item.documentFile.mimeType,
      'content-disposition': `attachment; filename="${escapeFilename(item.title)}${ext}"`,
      'cache-control': 'private, no-cache, no-store, must-revalidate',
    },
  });
}

function escapeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 80);
}
