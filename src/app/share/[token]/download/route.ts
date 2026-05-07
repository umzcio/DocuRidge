import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { readSealedPdf } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/**
 * Public sealed-PDF download route gated by the share token. Mirrors
 * /share/[token]/page.tsx's checks (token exists, not expired, not
 * revoked, envelope completed) and serves the sealed PDF stream.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const share = await prisma.envelopeShare.findUnique({
    where: { token },
    include: {
      envelope: {
        include: {
          sealed: { include: { documentFile: true } },
        },
      },
    },
  });
  if (!share) return new NextResponse('Not found', { status: 404 });
  if (share.revokedAt) return new NextResponse('Revoked', { status: 410 });
  if (share.expiresAt.getTime() < Date.now()) return new NextResponse('Expired', { status: 410 });
  if (share.envelope.status !== 'COMPLETED') return new NextResponse('Not available', { status: 404 });
  const sealed = share.envelope.sealed;
  if (!sealed) return new NextResponse('Not sealed', { status: 404 });

  const buf = await readSealedPdf(sealed.documentFile.storagePath);
  // Suggest a friendly filename to clients without leaking the envelope id.
  const filename = `${share.envelope.title.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'document'}.pdf`;
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, max-age=30',
    },
  });
}
