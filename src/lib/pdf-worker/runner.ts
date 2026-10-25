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
 *   unavailable    no worker entry (see entry.ts), or a child that could not
 *                  start: it failed to spawn or exited before sending `ready`.
 *                  That is the deployment's fault, not the PDF's.
 * An error the job itself threw rejects with that error, rebuilt.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { getLogger } from '../logger';
import { resolvePdfWorkerEntry, type PdfWorkerEntry } from './entry';
import { PdfWorkerError, reviveError, serializeErrorForChild, type PdfWorkerFailure } from './errors';
import { getPdfJobHandler } from './jobs';
import {
  OOM_SCORE_ADJ_PATH,
  parseChildMessage,
  serializeError,
  type ParentMessage,
  type PdfJobInput,
  type PdfJobKind,
  type PdfJobOutput,
  type SerializedError,
} from './protocol';

export { resolvePdfWorkerEntry, type PdfWorkerEntry } from './entry';
export { PdfWorkerError, type PdfWorkerFailure } from './errors';
export { OOM_SCORE_ADJ_PATH, type PdfJobInput, type PdfJobKind, type PdfJobOutput } from './protocol';

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
  /** Longest wait for a free slot before rejecting `busy`; default PDF_WORKER_QUEUE_MS. */
  queueMs?: number;
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

/** Names that look like secrets; never forwarded, even with a PDF_ prefix. */
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;

/**
 * The child's whole environment: NODE_ENV, TZ, every PDF_* variable whose
 * name does not look like a secret, and the image/field caps the PDF code
 * reads. Nothing else (no DATABASE_URL, keys dir, session secrets,
 * NODE_OPTIONS or PATH).
 */
export function pdfWorkerChildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (CHILD_ENV_NAMES.has(name) || (name.startsWith('PDF_') && !SECRET_NAME.test(name))) env[name] = value;
  }
  return env;
}

/** Cheap readiness check: resolves the entry by existence tests; spawns nothing. */
export function isPdfWorkerAvailable(): boolean {
  return resolvePdfWorkerEntry() !== null;
}

// ─── Slots ──────────────────────────────────────────────────────────────

interface SlotPool {
  active: number;
  waiting: Array<() => void>;
}

// Shared through globalThis: Next compiles server modules once per layer
// (route handlers, server actions), so a production build can hold several
// instances of this module. One pool keeps PDF_WORKER_CONCURRENCY a
// process-wide limit.
const SLOTS = Symbol.for('docuridge.pdfWorker.slots');
const slots: SlotPool = ((globalThis as Record<symbol, unknown>)[SLOTS] ??= {
  active: 0,
  waiting: [],
}) as SlotPool;

function admitWaiting(): void {
  const limit = positiveInt('PDF_WORKER_CONCURRENCY', DEFAULT_PDF_WORKER_CONCURRENCY);
  while (slots.waiting.length > 0 && slots.active < limit) slots.waiting.shift()!();
}

/** The configured slot wait (PDF_WORKER_QUEUE_MS). */
export function pdfWorkerQueueMs(): number {
  return positiveInt('PDF_WORKER_QUEUE_MS', DEFAULT_PDF_WORKER_QUEUE_MS);
}

/** The configured seal job limit (PDF_JOB_TIMEOUT_SEAL_MS). */
export function pdfSealJobTimeoutMs(): number {
  return defaultTimeoutMs('seal');
}

/** Resolves with a one-shot release once a slot is free; rejects `busy` after `queueMs`. */
function acquireSlot(queueMs: number): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const grant = () => {
      clearTimeout(timer);
      slots.active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        slots.active--;
        admitWaiting();
      });
    };
    const timer = setTimeout(() => {
      const at = slots.waiting.indexOf(grant);
      if (at >= 0) slots.waiting.splice(at, 1);
      reject(new PdfWorkerError('busy'));
    }, queueMs);
    slots.waiting.push(grant);
    admitWaiting();
  });
}

// ─── Child flags ────────────────────────────────────────────────────────

/** Node's permission-model flag for the running Node, or null if it has none. */
function permissionFlag(): string | null {
  const flags = process.allowedNodeEnvironmentFlags;
  if (flags.has('--permission')) return '--permission';
  if (flags.has('--experimental-permission')) return '--experimental-permission';
  return null;
}

let warnedNoPermission = false;

/**
 * Node flags for the child: the entry's own, the heap cap, and for a bundled
 * entry Node's permission model. Sandboxed, the child may read only its own
 * bundle and write only OOM_SCORE_ADJ_PATH; it may not spawn processes,
 * start workers or load addons (none of --allow-child-process,
 * --allow-worker, --allow-addons). The tsx source entry (dev and tests) runs
 * without it, because tsx reads the source tree and node_modules to compile.
 */
export function pdfWorkerExecArgv(entry: PdfWorkerEntry, heapMb: number): string[] {
  const args = [...entry.execArgv, `--max-old-space-size=${heapMb}`];
  if (!entry.sandboxed) return args;
  const flag = permissionFlag();
  if (!flag) {
    if (!warnedNoPermission) {
      warnedNoPermission = true;
      getLogger().warn(
        { node: process.version },
        'This Node has no permission model; the PDF worker runs without a filesystem sandbox',
      );
    }
    return args;
  }
  return [...args, flag, `--allow-fs-read=${entry.file}`, `--allow-fs-write=${OOM_SCORE_ADJ_PATH}`];
}

// ─── Public entry point ─────────────────────────────────────────────────

export async function runPdfJob<K extends PdfJobKind>(
  kind: K,
  input: PdfJobInput<K>,
  opts: RunPdfJobOptions = {},
): Promise<PdfJobOutput<K>> {
  if (process.env.PDF_WORKER_MODE === 'inline') {
    // Inline runs the job in this process: no heap cap, no time limit and the
    // full environment. Unit tests only, never a deployment.
    if (!process.env.VITEST || process.env.NODE_ENV === 'production') {
      throw new PdfWorkerError('unavailable', 'PDF_WORKER_MODE=inline is test-only');
    }
    return runInline(kind, input, opts);
  }
  const entry = resolvePdfWorkerEntry();
  if (!entry) throw new PdfWorkerError('unavailable');
  const release = await acquireSlot(opts.queueMs ?? pdfWorkerQueueMs());
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
      // Same round trip as IPC: the handler sees what a child would.
      askParent: (body) =>
        ask(body).catch((err: unknown) => Promise.reject(reviveError(serializeErrorForChild(err)))),
      isolated: false,
    });
  } catch (err) {
    throw reviveError(serializeError(err));
  }
}

type Outcome =
  | { kind: 'output'; output: unknown }
  | { kind: 'error'; error: SerializedError }
  | { kind: 'worker'; reason: PdfWorkerFailure; detail: string };

type SendResult = 'sent' | 'closed' | 'unsendable';

function runInChild(entry: PdfWorkerEntry, kind: PdfJobKind, input: unknown, opts: RunPdfJobOptions): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs(kind);
  const heapMb = opts.heapMb ?? positiveInt('PDF_WORKER_HEAP_MB', DEFAULT_PDF_WORKER_HEAP_MB);
  const ask = askWith(opts);

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = fork(entry.file, [], {
        execArgv: pdfWorkerExecArgv(entry, heapMb),
        env: pdfWorkerChildEnv() as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        serialization: 'advanced',
      });
    } catch (err) {
      getLogger().error(
        { kind, reason: 'unavailable', err: err instanceof Error ? err.message : String(err) },
        'The PDF worker could not be started',
      );
      reject(new PdfWorkerError('unavailable', 'The PDF worker could not be started'));
      return;
    }

    // Everything the child sends is untrusted: it parses untrusted PDFs.
    let outcome: Outcome | null = null;
    let ready = false;
    let jobSent = false;
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
    const failWorker = (reason: PdfWorkerFailure, detail: string) => {
      if (!outcome) outcome = { kind: 'worker', reason, detail };
      kill();
    };
    // child.send serializes synchronously and throws on values the
    // structured clone cannot copy; report that instead of throwing.
    const trySend = (msg: ParentMessage): SendResult => {
      if (!child.connected) return 'closed';
      try {
        child.send(msg, (err) => {
          // The child went away mid-send; its exit decides the outcome.
          if (err) kill();
        });
        return 'sent';
      } catch {
        return 'unsendable';
      }
    };
    const reply = (id: number, msg: ParentMessage) => {
      if (outcome) return;
      if (trySend(msg) === 'unsendable') {
        trySend({
          t: 'res',
          id,
          error: { name: 'Error', message: "The parent's answer could not be sent to the PDF worker" },
        });
      }
    };

    const timer = setTimeout(() => {
      if (outcome) return;
      timedOut = true;
      kill();
    }, timeoutMs);

    child.on('message', (raw: unknown) => {
      if (outcome) return;
      const m = parseChildMessage(raw);
      if (!m) return failWorker('crashed', 'malformed message from the PDF worker');
      switch (m.t) {
        case 'ready':
          ready = true;
          if (jobSent) return;
          jobSent = true;
          if (trySend({ t: 'job', kind, input }) !== 'sent') failWorker('crashed', 'the job could not be sent');
          return;
        case 'req':
          ask(m.body).then(
            (body) => reply(m.id, { t: 'res', id: m.id, body }),
            (err: unknown) => reply(m.id, { t: 'res', id: m.id, error: serializeErrorForChild(err) }),
          );
          return;
        case 'done':
          outcome = { kind: 'output', output: m.output };
          kill();
          return;
        case 'fail':
          outcome = { kind: 'error', error: m.error };
          kill();
          return;
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
      try {
        if (outcome?.kind === 'output') return resolve(outcome.output);
        if (outcome?.kind === 'error') return reject(reviveError(outcome.error));
        const reason =
          outcome?.kind === 'worker' ? outcome.reason : classifyExit({ timedOut, ready, code, signal, stderr: stderrTail });
        const details = {
          kind,
          reason,
          detail: outcome?.kind === 'worker' ? outcome.detail : undefined,
          exitCode: code,
          signal,
          stderrTail: stderrTail.slice(-2048),
        };
        if (reason === 'unavailable') {
          // Every job will fail the same way until the deployment is fixed.
          getLogger().error(details, 'The PDF worker exited before it was ready');
          return reject(new PdfWorkerError(reason, 'The PDF worker could not be started'));
        }
        getLogger().warn(details, 'PDF worker job failed');
        reject(new PdfWorkerError(reason));
      } catch {
        reject(new PdfWorkerError('crashed'));
      }
    }
  });
}

function classifyExit(exit: {
  timedOut: boolean;
  ready: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}): PdfWorkerFailure {
  const { timedOut, ready, code, signal, stderr } = exit;
  if (timedOut) return 'timeout';
  // It never got the job, so the PDF cannot be to blame.
  if (!ready) return 'unavailable';
  if (/heap out of memory|Reached heap limit/i.test(stderr) || signal === 'SIGABRT' || code === 134) {
    return 'out_of_memory';
  }
  return 'crashed';
}
