/**
 * The PDF worker child: entry point of `dist/pdf-worker.cjs` (production,
 * `/app/pdf-worker.cjs`) and, through tsx, of this file in dev and tests.
 *
 * Runs exactly one job and is then killed by the runner (see protocol.ts for
 * the IPC exchange). It has no secrets in its environment and must not read
 * user data from disk: everything it needs arrives in the job input, and
 * anything only the parent can do goes through `askParent`.
 */

import { getPdfJobHandler } from './jobs';
import { isMessage, serializeError, type ChildMessage, type ParentMessage } from './protocol';

const pending = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>();
let nextRequestId = 1;
let started = false;

function sendToParent(msg: ChildMessage, done?: (err: Error | null) => void): void {
  if (!process.send || !process.connected) {
    done?.(new Error('PDF worker: the IPC channel to the parent is closed'));
    return;
  }
  process.send(msg, undefined, {}, (err) => done?.(err ?? null));
}

/**
 * Ask the parent process a question (it answers through the runner's
 * `onRequest`). Only works inside a worker child; job handlers should use
 * `ctx.askParent`, which is this function in a child.
 */
export function askParent(body: unknown): Promise<unknown> {
  if (!process.send || !process.connected) {
    return Promise.reject(new Error('askParent() only works inside a PDF worker child'));
  }
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    sendToParent({ t: 'req', id, body }, (err) => {
      if (err && pending.delete(id)) reject(err);
    });
  });
}

async function runJob(kind: Extract<ParentMessage, { t: 'job' }>['kind'], input: unknown): Promise<void> {
  let reply: ChildMessage;
  try {
    const handler = getPdfJobHandler(kind);
    const output = await handler(input as never, { askParent, isolated: true });
    reply = { t: 'done', output };
  } catch (err) {
    reply = { t: 'fail', error: serializeError(err) };
  }
  // The runner kills this process once it has the reply; exit anyway.
  sendToParent(reply, () => process.exit(0));
}

function onMessage(msg: unknown): void {
  if (!isMessage(msg)) return;
  const m = msg as ParentMessage;
  if (m.t === 'job') {
    if (started) return; // one job per process
    started = true;
    void runJob(m.kind, m.input);
  } else if (m.t === 'res') {
    const waiter = pending.get(m.id);
    if (!waiter) return;
    pending.delete(m.id);
    if (m.error) {
      const err = new Error(m.error.message);
      err.name = m.error.name;
      waiter.reject(err);
    } else {
      waiter.resolve(m.body);
    }
  }
}

function main(): void {
  if (typeof process.send !== 'function') {
    process.stderr.write('pdf-worker: must be started by the PDF worker runner (no IPC channel)\n');
    process.exit(2);
  }
  process.on('message', onMessage);
  // The parent is gone: nobody can use the result.
  process.on('disconnect', () => process.exit(0));
  sendToParent({ t: 'ready' });
}

// Run only as a program (the esbuild bundle, or `node --import tsx child.ts`),
// never when this module is merely imported. `require`/`module` exist only
// when this file runs as CommonJS, as it does in both of those cases.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main();
}
