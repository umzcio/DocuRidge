import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The source entry, for dev and tests. Takes the root as a parameter so
 * Next's output tracing cannot resolve it statically and copy the source
 * file into the standalone build, where it is never used.
 */
function sourceEntry(root: string): string {
  return path.join(root, 'src', 'lib', 'pdf-worker', 'child.ts');
}

export interface PdfWorkerEntry {
  /** The script `fork` runs. */
  file: string;
  /** Node flags it needs (the runner adds the heap cap). */
  execArgv: string[];
  /**
   * Run under Node's permission model (read only the entry file). True for a
   * bundled `.cjs`; false for the tsx source entry, because tsx must read the
   * whole source tree and node_modules to compile it.
   */
  sandboxed: boolean;
}

/**
 * Where the PDF worker child lives, checked with existence tests only (no
 * spawn), so /readyz can call it on every probe:
 *   1. `PDF_WORKER_ENTRY` when set (null if that file is missing: a set but
 *      wrong path is a misconfiguration, not a reason to fall back);
 *   2. `<cwd>/pdf-worker.cjs`, the esbuild bundle in the production image;
 *   3. outside production only: `src/lib/pdf-worker/child.ts` through tsx.
 */
export function resolvePdfWorkerEntry(): PdfWorkerEntry | null {
  const explicit = process.env.PDF_WORKER_ENTRY;
  if (explicit) {
    const file = path.resolve(explicit);
    if (!existsSync(file)) return null;
    const ts = file.endsWith('.ts');
    return { file, execArgv: ts ? ['--import', 'tsx'] : [], sandboxed: !ts };
  }
  const bundled = path.join(process.cwd(), 'pdf-worker.cjs');
  if (existsSync(bundled)) return { file: bundled, execArgv: [], sandboxed: true };
  if (process.env.NODE_ENV !== 'production') {
    const source = sourceEntry(process.cwd());
    if (existsSync(source)) return { file: source, execArgv: ['--import', 'tsx'], sandboxed: false };
  }
  return null;
}
