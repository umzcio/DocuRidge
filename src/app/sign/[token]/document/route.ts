import { NextRequest, NextResponse } from 'next/server';
import { loadGatedSigningSession } from '@/lib/signing/session-gate';
import { canonicalFailureResponse, serveCanonicalDocument } from '@/lib/documents/serve';

/**
 * Serve one of the envelope's PDFs for a signing session. Auth: signing token,
 * recipient bound, plus the access-code unlock proof when the recipient has a
 * code. `?item=<envelope item id>` picks the document; without it, the first.
 * A signer is only ever shown the canonical copy (what the seal starts from),
 * never the uploaded original; if it cannot be shown, nothing is served.
 * Intentionally separate from the sender-facing sealed-PDF download route.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const session = await loadGatedSigningSession(token);
  if (!session.ok) {
    return new NextResponse('Document not available', { status: 403 });
  }
  const itemId = new URL(req.url).searchParams.get('item');
  const item = itemId
    ? session.envelope.items.find((i) => i.id === itemId)
    : session.envelope.items[0];
  if (!item) return new NextResponse('No document', { status: 404 });
  const served = await serveCanonicalDocument(item.documentFileId);
  if (!served.ok) return canonicalFailureResponse(served.status);
  return new NextResponse(new Uint8Array(served.bytes), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'cache-control': 'private, max-age=60',
    },
  });
}
