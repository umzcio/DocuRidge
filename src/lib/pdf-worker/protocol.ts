import type { InspectResult } from '../pdf/inspect-upload';
import type { SealJobOutput, SealRenderInput } from '../pdf/seal-render';

/**
 * Types and wire format shared by the PDF worker runner (parent) and the
 * worker child. Imports nothing at runtime, so the child bundle stays small.
 *
 * IPC (`child_process.fork`, `serialization: 'advanced'`, so typed arrays
 * cross as typed arrays):
 *
 *   child  -> parent  { t: 'ready' }                       IPC is up, send the job
 *   parent -> child   { t: 'job', kind, input }            exactly once per child
 *   child  -> parent  { t: 'req', id, body }               askParent(body)
 *   parent -> child   { t: 'res', id, body } | { t: 'res', id, error }
 *   child  -> parent  { t: 'done', output } | { t: 'fail', error }
 *
 * After `done`/`fail` the parent kills the child; a child never runs a second
 * job. Errors cross as `SerializedError` and are rebuilt by `reviveError`
 * (errors.ts) in the parent.
 */

/** The one file a sandboxed child may write: its own OOM-kill priority. */
export const OOM_SCORE_ADJ_PATH = '/proc/self/oom_score_adj';

export type PdfJobKind = 'inspect' | 'seal' | 'ping' | 'diagnostic';

/** The `'ping'` job's only answer: proof that a child started and ran a job. */
export const PING_REPLY = 'pong';

/** Test-only job, registered only when `PDF_WORKER_DIAGNOSTICS === '1'`. */
export type DiagnosticInput =
  | { op: 'echo'; bytes: Uint8Array }
  | { op: 'spin' }
  | { op: 'allocate' }
  | { op: 'exit'; code: number }
  | { op: 'env' }
  | { op: 'pid' }
  | { op: 'ask'; question: string }
  /** Send `message` to the parent verbatim (protocol fuzzing), then wait to be killed. */
  | { op: 'send'; message: unknown }
  /** Try to read a file; reports the error code instead of throwing. */
  | { op: 'readFile'; path: string };

export interface DiagnosticOutput {
  /** `echo` */
  bytes?: Uint8Array;
  /** `env`: the child's whole environment. */
  env?: Record<string, string>;
  /** `pid` */
  pid?: number;
  /** `ask`: the parent's reply. */
  answer?: unknown;
  /** `readFile`: the error code when the read failed (its bytes go in `bytes`). */
  readError?: string;
}

/**
 * Job input by kind. Later tasks add their kinds here ('inspect', 'seal');
 * a kind without an entry has input `never`, so it cannot be called.
 */
export interface PdfJobInputMap {
  inspect: { bytes: Uint8Array; ignoreEncryption?: boolean };
  seal: SealRenderInput;
  /** Smoke test (readyz): no input; reads nothing, so it runs under the sandbox. */
  ping: Record<string, never>;
  diagnostic: DiagnosticInput;
}

/** Job output by kind; see PdfJobInputMap. */
export interface PdfJobOutputMap {
  inspect: InspectResult;
  seal: SealJobOutput;
  ping: typeof PING_REPLY;
  diagnostic: DiagnosticOutput;
}

export type PdfJobInput<K extends PdfJobKind> = K extends keyof PdfJobInputMap ? PdfJobInputMap[K] : never;
export type PdfJobOutput<K extends PdfJobKind> = K extends keyof PdfJobOutputMap ? PdfJobOutputMap[K] : never;

export interface PdfJobContext {
  /**
   * Ask the parent process a question; resolves with `opts.onRequest`'s
   * answer. Inline, it calls `onRequest` directly.
   */
  askParent(body: unknown): Promise<unknown>;
  /** True in a worker child, false when the job runs inline. */
  isolated: boolean;
}

export type PdfJobHandler<K extends PdfJobKind> = (
  input: PdfJobInput<K>,
  ctx: PdfJobContext,
) => Promise<PdfJobOutput<K>>;

/** An error as it crosses the process boundary. */
export interface SerializedError {
  name: string;
  message: string;
  /** PdfComplexityError / PdfDecodeLimitError */
  limit?: string;
  /** PdfDecodeLimitError */
  limitBytes?: number;
  /** PdfComplexityError / PdfDecodeLimitError / SealedContentStructureError */
  code?: string;
}

export type ParentMessage =
  | { t: 'job'; kind: PdfJobKind; input: unknown }
  | { t: 'res'; id: number; body?: unknown; error?: SerializedError };

export type ChildMessage =
  | { t: 'ready' }
  | { t: 'req'; id: number; body: unknown }
  | { t: 'done'; output: unknown }
  | { t: 'fail'; error: SerializedError };

export function serializeError(err: unknown): SerializedError {
  if (!(err instanceof Error)) return { name: 'Error', message: String(err) };
  const out: SerializedError = { name: err.name, message: err.message };
  const extra = err as Error & { limit?: unknown; limitBytes?: unknown; code?: unknown };
  if (typeof extra.limit === 'string') out.limit = extra.limit;
  if (typeof extra.limitBytes === 'number') out.limitBytes = extra.limitBytes;
  if (typeof extra.code === 'string') out.code = extra.code;
  return out;
}

/** Runtime check on a message from the other side of the pipe. */
export function isMessage(value: unknown): value is { t: string } {
  return typeof value === 'object' && value !== null && typeof (value as { t?: unknown }).t === 'string';
}

/** A well-formed SerializedError: an object with string `name` and `message`. */
export function isSerializedError(value: unknown): value is SerializedError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && typeof v.message === 'string';
}

/**
 * Validate a message from the child. The child parses untrusted PDFs, so
 * the parent treats everything it sends as untrusted: null for anything that
 * is not exactly one of the ChildMessage shapes.
 */
export function parseChildMessage(value: unknown): ChildMessage | null {
  if (!isMessage(value)) return null;
  const v = value as Record<string, unknown>;
  switch (v.t) {
    case 'ready':
      return { t: 'ready' };
    case 'req':
      return Number.isSafeInteger(v.id) ? { t: 'req', id: v.id as number, body: v.body } : null;
    case 'done':
      return Object.prototype.hasOwnProperty.call(v, 'output') ? { t: 'done', output: v.output } : null;
    case 'fail':
      return isSerializedError(v.error) ? { t: 'fail', error: v.error } : null;
    default:
      return null;
  }
}
