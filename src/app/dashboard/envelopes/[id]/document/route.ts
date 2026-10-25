import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getEnvelopeForOwner } from '@/lib/envelopes/service';
import { canonicalFailureResponse, serveCanonicalDocument } from '@/lib/documents/serve';
import { readPdfFromStorage, readSealedPdf } from '@/lib/storage';
import { prisma } from '@/lib/prisma';

/**
 * Serve a PDF item of an envelope to the sender. If the envelope has been
 * sealed, prefer the sealed PDF (with stamped signatures and audit page) so
 * "Open in new tab" reflects what the recipient actually signed. Pass
 * ?original=1 to force the pre-seal document, which is the canonical copy
 * (what signers saw). Pass ?upload=1 for the bytes as uploaded.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return new NextResponse('Sign in required', { status: 401 });
  const { id } = await params;
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };
  const env = await getEnvelopeForOwner(ctx, id);
  if (!env) return new NextResponse('Not found', { status: 404 });

  const wantsOriginal = req.nextUrl.searchParams.get('original') === '1';
  if (!wantsOriginal) {
    const sealed = await prisma.sealedDocument.findUnique({
      where: { envelopeId: env.id },
      include: { documentFile: true },
    });
    if (sealed) {
      const buf = await readSealedPdf(sealed.documentFile.storagePath);
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'cache-control': 'private, max-age=60',
        },
      });
    }
  }

  // Optional ?item=N selects which item; default to the first.
  const itemIdx = Math.max(0, parseInt(req.nextUrl.searchParams.get('item') ?? '0', 10));
  const item = env.items[itemIdx] ?? env.items[0];
  if (!item) return new NextResponse('No document', { status: 404 });

  let body: Buffer;
  if (req.nextUrl.searchParams.get('upload') === '1') {
    body = await readPdfFromStorage(item.documentFile.storagePath);
  } else {
    const served = await serveCanonicalDocument(item.documentFileId);
    if (!served.ok) return canonicalFailureResponse(served.status);
    body = served.bytes;
  }
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'cache-control': 'private, max-age=60',
    },
  });
}
