import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

/**
 * Serve the pdfjs-dist worker as a JS module, scoped under /DocuRidge/pdf-worker.
 *
 * Why a route handler instead of /public:
 *  - Avoids committing a vendor binary into the repo.
 *  - Survives a `pdfjs-dist` upgrade without a separate copy step.
 *  - Works under Next.js standalone output without a Dockerfile patch.
 */

const require_ = createRequire(import.meta.url);

let cached: Buffer | null = null;

async function loadWorker(): Promise<Buffer> {
  if (cached) return cached;
  const path = require_.resolve('pdfjs-dist/build/pdf.worker.mjs');
  cached = await readFile(path);
  return cached;
}

export async function GET() {
  const buf = await loadWorker();
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
