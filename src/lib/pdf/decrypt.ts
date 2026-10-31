import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class QpdfPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QpdfPasswordError';
  }
}

export class QpdfMissingError extends Error {
  constructor() {
    super('qpdf binary not found in PATH');
    this.name = 'QpdfMissingError';
  }
}

/** qpdf's output would be larger than the caller's cap; nothing was read. */
export class QpdfOutputTooLargeError extends Error {
  constructor(readonly maxOutputBytes: number) {
    super(`Decrypted PDF exceeds ${maxOutputBytes} bytes`);
    this.name = 'QpdfOutputTooLargeError';
  }
}

/** No qpdf slot came free within QPDF_QUEUE_MS. */
export class QpdfBusyError extends Error {
  constructor() {
    super('Too many PDFs are being decrypted; the request waited too long');
    this.name = 'QpdfBusyError';
  }
}

/** qpdf runs at once in this process; later calls wait for a slot. */
export const QPDF_CONCURRENCY = 2;
/** Longest wait for a slot before QpdfBusyError. */
export const QPDF_QUEUE_MS = 30_000;
/** Wall-clock limit for one qpdf run. */
export const QPDF_TIMEOUT_MS = 30_000;
/** Address-space limit for one qpdf process (ulimit -v, KiB). */
export const QPDF_MAX_MEMORY_KIB = 1024 * 1024;

/**
 * qpdf only removes the encryption: `--stream-data=preserve` keeps every
 * stream's filters and bytes as they are (no decode, no re-encode), so a
 * small stream that decodes to gigabytes stays small. Object streams are
 * still rewritten uncompressed, so the output can outgrow the input; the
 * file-size limit and the stat below bound that.
 */
const QPDF_ARGS = ['--stream-data=preserve', '--decrypt'];

/**
 * Runs qpdf under `ulimit` (file size and address space), so an output past
 * the cap, or a parse that would take the host's memory, fails inside qpdf
 * rather than in the parent. `exec` keeps one process; a missing qpdf exits
 * 127. `-f` counts 512-byte blocks in every POSIX sh.
 */
const QPDF_WRAPPER = 'ulimit -f "$1" && ulimit -v "$2" || exit 125; shift 2; exec qpdf "$@"';

// ─── Slots ──────────────────────────────────────────────────────────────

interface SlotPool {
  active: number;
  waiting: Array<() => void>;
}

// Shared through globalThis, as the PDF worker's pool is: Next can load this
// module more than once, and the limit is per process.
const SLOTS = Symbol.for('docuridge.qpdf.slots');
const slots: SlotPool = ((globalThis as Record<symbol, unknown>)[SLOTS] ??= {
  active: 0,
  waiting: [],
}) as SlotPool;

function admitWaiting(): void {
  while (slots.waiting.length > 0 && slots.active < QPDF_CONCURRENCY) slots.waiting.shift()!();
}

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
      reject(new QpdfBusyError());
    }, queueMs);
    slots.waiting.push(grant);
    admitWaiting();
  });
}

/** Size of `path`, or -1 when there is no file. */
async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

/**
 * Decrypt an owner-password-protected PDF using qpdf.
 *
 * Why this exists: pdf-lib's `ignoreEncryption: true` skips the password
 * check at load time but does NOT actually decrypt the content streams.
 * If you copy pages from such a document into a new one and save, the
 * resulting PDF embeds still-encrypted streams that no reader can render
 * (sealed PDF appears blank). qpdf actually decrypts.
 *
 * For owner-password PDFs (the common case — "Save with security" output,
 * government/financial reports, PDF-form generators), qpdf decrypts with
 * no password supplied. For user-password PDFs, qpdf throws and we surface
 * a friendly "open in a reader and re-save without the password" error.
 *
 * qpdf runs at most QPDF_CONCURRENCY at a time (QpdfBusyError after
 * QPDF_QUEUE_MS), and its output is measured on disk before it is read: one
 * larger than `maxOutputBytes` throws QpdfOutputTooLargeError, so the parent
 * never holds more than the cap.
 *
 * Returns the decrypted bytes. Caller is responsible for replacing the
 * original buffer before persisting.
 */
export async function decryptPdf(
  input: Buffer,
  opts: { maxOutputBytes: number; queueMs?: number },
): Promise<Buffer> {
  const release = await acquireSlot(opts.queueMs ?? QPDF_QUEUE_MS);
  const dir = await mkdtemp(join(tmpdir(), 'docuridge-qpdf-')).catch((err) => {
    release();
    throw err;
  });
  const inPath = join(dir, 'in.pdf');
  const outPath = join(dir, 'out.pdf');
  // Room for one byte past the cap, so an output that reaches the limit is
  // always larger than the cap and is refused below.
  const fileBlocks = Math.ceil((opts.maxOutputBytes + 1) / 512);
  try {
    await writeFile(inPath, input);
    try {
      await execFileAsync(
        '/bin/sh',
        ['-c', QPDF_WRAPPER, 'qpdf', String(fileBlocks), String(QPDF_MAX_MEMORY_KIB), ...QPDF_ARGS, inPath, outPath],
        { timeout: QPDF_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      );
    } catch (err) {
      const e = err as { code?: string | number; signal?: string; stderr?: string };
      if (e.code === 'ENOENT' || e.code === 127) throw new QpdfMissingError();
      // Killed at the file-size limit (SIGXFSZ), or a write that failed there.
      if (e.signal === 'SIGXFSZ' || (await sizeOf(outPath)) > opts.maxOutputBytes) {
        throw new QpdfOutputTooLargeError(opts.maxOutputBytes);
      }
      const stderr = e.stderr ?? '';
      // qpdf exits non-zero with a clear message on user-password PDFs.
      // 'invalid password' / 'requires a password' / etc.
      if (/password|encrypt|protected/i.test(stderr)) {
        throw new QpdfPasswordError(stderr.trim());
      }
      throw err;
    }
    if ((await sizeOf(outPath)) > opts.maxOutputBytes) throw new QpdfOutputTooLargeError(opts.maxOutputBytes);
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    release();
  }
}
