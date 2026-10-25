/**
 * Runs PDF jobs in a disposable child process: one fresh `fork` per job, with
 * a V8 heap cap, a wall-clock limit, an allowlisted environment (no secrets)
 * and bytes in, bytes out. At most `PDF_WORKER_CONCURRENCY` children run at
 * once; later jobs wait up to `PDF_WORKER_QUEUE_MS` for a slot.
 *
 * Every setting is read from `process.env` per call, so tests can switch
 * `PDF_WORKER_MODE` (`process` | `inline`) between cases. Inline mode runs
 * the handler in this process (unit tests only); it shares the error
 * round trip, so callers see the same error classes in both modes.
 *
 * Failures of the worker itself reject with PdfWorkerError:
 *   timeout        the job ran past its limit; the child got SIGKILL
 *   out_of_memory  the child died of a V8 heap OOM (stderr / SIGABRT / 134)
 *   crashed        any other exit or disconnect before a result
 *   busy           no slot within PDF_WORKER_QUEUE_MS
 *   unavailable    no worker entry (see entry.ts)
 * An error the job itself threw rejects with that error, rebuilt.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { getLogger } from '../logger';
import { resolvePdfWorkerEntry, type PdfWorkerEntry } from './entry';
import { PdfWorkerError, reviveError, type PdfWorkerFailure } from './errors';
import { getPdfJobHandler } from './jobs';
import {
  isMessage,
  serializeError,
  type ChildMessage,
  type ParentMessage,
  type PdfJobInput,
  type PdfJobKind,
  type PdfJobOutput,
  type SerializedError,
} from './protocol';

export { resolvePdfWorkerEntry, type PdfWorkerEntry } from './entry';
export { PdfWorkerError, type PdfWorkerFailure } from './errors';
export type { PdfJobInput, PdfJobKind, PdfJobOutput } from './protocol';

export const DEFAULT_PDF_WORKER_HEAP_MB = 512;
export const DEFAULT_PDF_WORKER_CONCURRENCY = 2;
export const DEFAULT_PDF_WORKER_QUEUE_MS = 30_000;
export const DEFAULT_PDF_JOB_TIMEOUT_UPLOAD_MS = 30_000;
export const DEFAULT_PDF_JOB_TIMEOUT_SEAL_MS = 60_000;

/** Bytes of child stderr kept to classify an exit. */
const STDERR_TAIL_BYTES = 8192;

export interface RunPdfJobOptions {
  /** Wall-clock limit from spawn; default by kind (PDF_JOB_TIMEOUT_*_MS). */
  timeoutMs?: number;
  /** V8 old-space cap for the child; default PDF_WORKER_HEAP_MB. */
  heapMb?: number;
  /** Answers the child's `askParent(body)`. */
  onRequest?: (req: unknown) => Promise<unknown>;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultTimeoutMs(kind: PdfJobKind): number {
  return kind === 'seal'
    ? positiveInt('PDF_JOB_TIMEOUT_SEAL_MS', DEFAULT_PDF_JOB_TIMEOUT_SEAL_MS)
    : positiveInt('PDF_JOB_TIMEOUT_UPLOAD_MS', DEFAULT_PDF_JOB_TIMEOUT_UPLOAD_MS);
}

const CHILD_ENV_NAMES = new Set([
  'NODE_ENV',
  'TZ',
  'MAX_IMAGE_DIMENSION',
  'MAX_IMAGE_PIXELS',
  'MAX_SIGNATURE_IMAGE_BYTES',
  'SEAL_MAX_IMAGE_PIXELS',
  'ENVELOPE_MAX_FIELDS',
  'ENVELOPE_MAX_FIELDS_PER_PAGE',
]);

/**
 * The child's whole environment: NODE_ENV, TZ, every PDF_* variable and the
 * image/field caps the PDF code reads. Nothing else (no DATABASE_URL, keys
 * dir, session secrets, NODE_OPTIONS or PATH).
 */
export function pdfWorkerChildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (CHILD_ENV_NAMES.has(name) || name.startsWith('PDF_')) env[name] = value;
  }
  return env;
}

/** Cheap readiness check: resolves the entry by existence tests; spawns nothing. */
export function isPdfWorkerAvailable(): boolean {
  return resolvePdfWorkerEntry() !== null;
}

// ─── Slots ──────────────────────────────────────────────────────────────

let active = 0;
const waiting: Array<() => void> = [];

function admitWaiting(): void {
  const limit = positiveInt('PDF_WORKER_CONCURRENCY', DEFAULT_PDF_WORKER_CONCURRENCY);
  while (waiting.length > 0 && active < limit) waiting.shift()!();
}

/** Resolves with a one-shot release once a slot is free; rejects `busy`. */
function acquireSlot(): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const grant = () => {
      clearTimeout(timer);
      active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active--;
        admitWaiting();
      });
    };
    const timer = setTimeout(() => {
      const at = waiting.indexOf(grant);
      if (at >= 0) waiting.splice(at, 1);
      reject(new PdfWorkerError('busy'));
    }, positiveInt('PDF_WORKER_QUEUE_MS', DEFAULT_PDF_WORKER_QUEUE_MS));
    waiting.push(grant);
    admitWaiting();
  });
}

// ─── Public entry point ─────────────────────────────────────────────────

export async function runPdfJob<K extends PdfJobKind>(
  kind: K,
  input: PdfJobInput<K>,
  opts: RunPdfJobOptions = {},
): Promise<PdfJobOutput<K>> {
  if (process.env.PDF_WORKER_MODE === 'inline') return runInline(kind, input, opts);
  const entry = resolvePdfWorkerEntry();
  if (!entry) throw new PdfWorkerError('unavailable');
  const release = await acquireSlot();
  try {
    return (await runInChild(entry, kind, input, opts)) as PdfJobOutput<K>;
  } finally {
    release();
  }
}

function askWith(opts: RunPdfJobOptions): (body: unknown) => Promise<unknown> {
  return async (body) => {
    if (!opts.onRequest) throw new Error('This PDF job asked the parent a question, but the caller set no onRequest');
    return opts.onRequest(body);
  };
}

async function runInline<K extends PdfJobKind>(
  kind: K,
  input: PdfJobInput<K>,
  opts: RunPdfJobOptions,
): Promise<PdfJobOutput<K>> {
  const ask = askWith(opts);
  try {
    const handler = getPdfJobHandler(kind);
    return await handler(input, {
      // Same round trip as IPC: the handler sees a rebuilt error.
      askParent: (body) => ask(body).catch((err: unknown) => Promise.reject(reviveError(serializeError(err)))),
      isolated: false,
    });
  } catch (err) {
    throw reviveError(serializeError(err));
  }
}

type Outcome = { ok: true; output: unknown } | { ok: false; error: SerializedError };

function runInChild(entry: PdfWorkerEntry, kind: PdfJobKind, input: unknown, opts: RunPdfJobOptions): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs(kind);
  const heapMb = opts.heapMb ?? positiveInt('PDF_WORKER_HEAP_MB', DEFAULT_PDF_WORKER_HEAP_MB);
  const ask = askWith(opts);

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = fork(entry.file, [], {
        execArgv: [...entry.execArgv, `--max-old-space-size=${heapMb}`],
        env: pdfWorkerChildEnv() as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        serialization: 'advanced',
      });
    } catch {
      reject(new PdfWorkerError('crashed', 'The PDF worker could not be started'));
      return;
    }

    let outcome: Outcome | null = null;
    let timedOut = false;
    let settled = false;
    let stderrTail = '';

    // Drain both pipes so a chatty child can never block on a full pipe.
    child.stdout?.resume();
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });

    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const send = (msg: ParentMessage) => {
      if (!child.connected) return;
      child.send(msg, (err) => {
        // The child went away mid-send; its exit decides the outcome.
        if (err) kill();
      });
    };

    const timer = setTimeout(() => {
      if (outcome) return;
      timedOut = true;
      kill();
    }, timeoutMs);

    child.on('message', (msg: unknown) => {
      if (outcome || !isMessage(msg)) return;
      const m = msg as ChildMessage;
      switch (m.t) {
        case 'ready':
          send({ t: 'job', kind, input });
          break;
        case 'req':
          ask(m.body).then(
            (body) => {
              if (!outcome) send({ t: 'res', id: m.id, body });
            },
            (err: unknown) => {
              if (!outcome) send({ t: 'res', id: m.id, error: serializeError(err) });
            },
          );
          break;
        case 'done':
          outcome = { ok: true, output: m.output };
          kill();
          break;
        case 'fail':
          outcome = { ok: false, error: m.error };
          kill();
          break;
      }
    });

    // A child that drops IPC without a result cannot finish the job.
    child.on('disconnect', () => {
      if (!outcome) kill();
    });

    // Spawn failure; 'close' may never follow.
    child.on('error', () => {
      if (child.pid === undefined) finish(null, null);
      else kill();
    });

    // 'close' fires after exit and after stdio is drained, so the stderr
    // tail is complete when the exit is classified.
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal));

    function finish(code: number | null, signal: NodeJS.Signals | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome?.ok) return resolve(outcome.output);
      if (outcome) return reject(reviveError(outcome.error));
      const reason = classifyExit(timedOut, code, signal, stderrTail);
      getLogger().warn(
        { kind, reason, exitCode: code, signal, stderrTail: stderrTail.slice(-2048) },
        'PDF worker job failed',
      );
      reject(new PdfWorkerError(reason));
    }
  });
}

function classifyExit(
  timedOut: boolean,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): PdfWorkerFailure {
  if (timedOut) return 'timeout';
  if (/heap out of memory|Reached heap limit/i.test(stderr) || signal === 'SIGABRT' || code === 134) {
    return 'out_of_memory';
  }
  return 'crashed';
}
