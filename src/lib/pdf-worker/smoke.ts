/**
 * One-time smoke test of the PDF worker for /readyz: runs a `'ping'` job in
 * a real child, so a worker that cannot start (a bad bundle, a Node without
 * the flags it needs, a sandbox that blocks its own entry) turns readiness
 * red instead of failing every upload and seal.
 *
 * The result is cached for the life of the process: a success forever, a
 * failure for at most RETRY_AFTER_FAILURE_MS, after which the next probe
 * runs the job again. Concurrent probes share one run. A `busy` worker is
 * inconclusive (the worker is up, just occupied): it is not cached and does
 * not fail readiness.
 */

import { getLogger } from '../logger';
import { PING_REPLY } from './protocol';
import { PdfWorkerError, runPdfJob } from './runner';

export const PDF_WORKER_SMOKE_RETRY_MS = 60_000;
/** The smoke job's wall-clock and slot-wait limits; a probe must answer promptly. */
const SMOKE_TIMEOUT_MS = 15_000;
const SMOKE_QUEUE_MS = 5_000;

export type PdfWorkerSmokeResult = 'ok' | 'failed' | 'busy';

interface SmokeState {
  result?: { ok: boolean; at: number };
  running?: Promise<PdfWorkerSmokeResult>;
}

let state: SmokeState = {};

/** For tests: forget the cached result. */
export function resetPdfWorkerSmokeTest(): void {
  state = {};
}

async function runSmokeJob(): Promise<PdfWorkerSmokeResult> {
  try {
    const out = await runPdfJob('ping', {}, { timeoutMs: SMOKE_TIMEOUT_MS, queueMs: SMOKE_QUEUE_MS });
    if (out === PING_REPLY) return 'ok';
    getLogger().error({ job: 'ping' }, 'PDF worker smoke test returned an unexpected answer');
    return 'failed';
  } catch (err) {
    if (err instanceof PdfWorkerError && err.reason === 'busy') return 'busy';
    getLogger().error(
      { job: 'ping', reason: err instanceof PdfWorkerError ? err.reason : undefined, err: err instanceof Error ? err.message : String(err) },
      'PDF worker smoke test failed',
    );
    return 'failed';
  }
}

/** The cached smoke-test result, running the job when none is cached or a failure is stale. */
export async function pdfWorkerSmokeTest(now: () => number = Date.now): Promise<PdfWorkerSmokeResult> {
  const cached = state.result;
  if (cached && (cached.ok || now() - cached.at < PDF_WORKER_SMOKE_RETRY_MS)) return cached.ok ? 'ok' : 'failed';
  const current = state;
  current.running ??= runSmokeJob()
    .then((result) => {
      if (result !== 'busy') current.result = { ok: result === 'ok', at: now() };
      return result;
    })
    .finally(() => {
      current.running = undefined;
    });
  const result = await current.running;
  // A busy worker during a retry keeps the last known failure.
  if (result === 'busy' && cached && !cached.ok) return 'failed';
  return result;
}
