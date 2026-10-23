import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guardApiRequest, notFoundJson } from '@/lib/api/guard';
import { serializeDocument } from '@/lib/api/serializers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/envelopes/:id/documents — the envelope's document list.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await guardApiRequest(req, 'read');
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const env = await prisma.envelope.findFirst({
    where: { id, orgId: guard.auth.token.orgId, deletedAt: null, type: 'DOCUMENT' },
    include: {
      items: { include: { documentFile: true }, orderBy: { order: 'asc' } },
    },
  });
  if (!env) return notFoundJson('Envelope not found.');

  return NextResponse.json({ documents: env.items.map(serializeDocument) });
}
