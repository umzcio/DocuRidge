import { NextRequest, NextResponse } from 'next/server';
import { loadGatedSigningSession } from '@/lib/signing/session-gate';
import { readPdfFromStorage } from '@/lib/storage';
import { prisma } from '@/lib/prisma';

/**
 * Serve the PDF for a signing session. Auth: signing token, recipient bound,
 * plus the access-code unlock proof when the recipient has a code.
 * Intentionally separate from the sender-facing sealed-PDF download route.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const session = await loadGatedSigningSession(token);
  if (!session.ok) {
    return new NextResponse('Document not available', { status: 403 });
  }
  const item = session.envelope.items[0];
  if (!item) return new NextResponse('No document', { status: 404 });
  const buffer = await readPdfFromStorage(item.documentFile.storagePath);
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'cache-control': 'private, max-age=60',
    },
  });
}
