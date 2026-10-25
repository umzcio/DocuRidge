/**
 * The job handlers, by kind. Runs in the worker child (and inline under
 * unit tests); must not import the database, keys or env loader.
 */

import { readFileSync } from 'node:fs';
import { inspectUploadedPdf } from '../pdf/inspect-upload';
import type { DiagnosticInput, DiagnosticOutput, PdfJobContext, PdfJobHandler, PdfJobKind } from './protocol';

type HandlerTable = { [K in PdfJobKind]?: PdfJobHandler<K> };

/** Production handlers. Tasks that add a kind register it here. */
const HANDLERS: HandlerTable = {
  inspect: (input) => inspectUploadedPdf(input.bytes),
};

function refuseInline(op: string, ctx: PdfJobContext): void {
  if (!ctx.isolated) throw new Error(`diagnostic op "${op}" only runs in a worker process`);
}

async function diagnostic(input: DiagnosticInput, ctx: PdfJobContext): Promise<DiagnosticOutput> {
  switch (input.op) {
    case 'echo':
      if (!(input.bytes instanceof Uint8Array)) throw new Error('diagnostic echo needs a Uint8Array');
      return { bytes: input.bytes };
    case 'spin':
      refuseInline(input.op, ctx);
      for (;;) {
        // burn CPU until the runner kills this process
      }
    case 'allocate': {
      refuseInline(input.op, ctx);
      const hold: number[][] = [];
      for (;;) hold.push(new Array<number>(1_000_000).fill(hold.length));
    }
    case 'exit':
      refuseInline(input.op, ctx);
      process.exit(input.code);
    case 'env': {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      return { env };
    }
    case 'pid':
      return { pid: process.pid };
    case 'ask':
      return { answer: await ctx.askParent(input.question) };
    case 'send':
      refuseInline(input.op, ctx);
      process.send?.(input.message);
      return new Promise<never>(() => {}); // the runner kills this process
    case 'readFile':
      try {
        return { bytes: new Uint8Array(readFileSync(input.path)) };
      } catch (err) {
        return { readError: String((err as { code?: unknown }).code ?? 'unknown') };
      }
    default:
      throw new Error(`unknown diagnostic op ${JSON.stringify((input as { op?: unknown }).op)}`);
  }
}

/**
 * The handler for `kind`, or a clear error when none is registered.
 * 'diagnostic' exists only when `PDF_WORKER_DIAGNOSTICS === '1'` and never
 * when `NODE_ENV === 'production'` (both read now).
 */
export function getPdfJobHandler<K extends PdfJobKind>(kind: K): PdfJobHandler<K> {
  if (
    kind === 'diagnostic' &&
    process.env.PDF_WORKER_DIAGNOSTICS === '1' &&
    process.env.NODE_ENV !== 'production'
  ) {
    return diagnostic as unknown as PdfJobHandler<K>;
  }
  const handler = Object.prototype.hasOwnProperty.call(HANDLERS, kind) ? HANDLERS[kind] : undefined;
  if (!handler) throw new Error(`No PDF job handler is registered for "${String(kind)}"`);
  return handler as PdfJobHandler<K>;
}
