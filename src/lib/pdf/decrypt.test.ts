import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { doubleFlate } from './__fixtures__/bomb-pdf';
import { encryptedPdf } from './__fixtures__/encrypted-pdf';

// Spy on readFile so a test can show an over-cap output is never read.
vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const { readFile } = await import('node:fs/promises');
const {
  QPDF_CONCURRENCY,
  QpdfBusyError,
  QpdfMissingError,
  QpdfOutputTooLargeError,
  QpdfPasswordError,
  decryptPdf,
} = await import('./decrypt');

const KiB = 1024;
const input = Buffer.from('%PDF-1.7\n' + 'x'.repeat(1000));

/** Real qpdf on the host's PATH, if any (CI images may have it; dev hosts may not). */
const realQpdf = (() => {
  try {
    execFileSync('qpdf', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('decryptPdf with a stand-in qpdf', () => {
  let work: string;
  let bin: string;
  let log: string;
  const tmpBefore = () => readdirSync(tmpdir()).filter((n) => n.startsWith('docuridge-qpdf-'));

  /** Put a `qpdf` shell script on PATH; it gets IN as $N-1 and OUT as $N, and logs its argv. */
  function stub(body: string): void {
    writeFileSync(
      join(bin, 'qpdf'),
      `#!/bin/sh\nfor last; do :; done\nout="$last"\nprintf '%s\\n' "$*" >> "${log}"\n${body}\n`,
    );
    chmodSync(join(bin, 'qpdf'), 0o755);
  }

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'docuridge-decrypt-test-'));
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  beforeEach(() => {
    bin = mkdtempSync(join(work, 'bin-'));
    log = join(bin, 'argv.log');
    writeFileSync(log, '');
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
    vi.mocked(readFile).mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('asks qpdf to keep stream data as it is and returns its output', async () => {
    stub('in=""; for a; do [ "$a" = "$out" ] || in="$a"; done; cat "$in" > "$out"');
    const out = await decryptPdf(input, { maxOutputBytes: 64 * KiB });
    expect(out.equals(input)).toBe(true);
    const argv = readFileSync(log, 'utf8').trim().split(' ');
    expect(argv).toContain('--stream-data=preserve');
    expect(argv).toContain('--decrypt');
  });

  it('refuses an output over the cap before reading it, and removes it', async () => {
    const before = tmpBefore();
    stub('head -c 70000 /dev/zero > "$out"');
    await expect(decryptPdf(input, { maxOutputBytes: 64 * KiB })).rejects.toBeInstanceOf(QpdfOutputTooLargeError);
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(tmpBefore()).toEqual(before);
  });

  it('an output exactly at the cap is read', async () => {
    stub(`head -c ${64 * KiB} /dev/zero > "$out"`);
    expect((await decryptPdf(input, { maxOutputBytes: 64 * KiB })).length).toBe(64 * KiB);
  });

  it('stops a runaway output at the file-size limit (300 MiB asked, cap 64 KiB)', async () => {
    stub('head -c 314572800 /dev/zero > "$out"');
    const started = Date.now();
    const err = await decryptPdf(input, { maxOutputBytes: 64 * KiB }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QpdfOutputTooLargeError);
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it(`runs at most ${QPDF_CONCURRENCY} qpdf at once and queues the rest`, async () => {
    const running = join(bin, 'running');
    // Each run notes how many runs it saw at once (directory entries), then holds its slot briefly.
    stub(`mkdir -p "${running}"; touch "${running}/$$"; ls "${running}" | wc -l >> "${bin}/seen"; sleep 0.2; rm "${running}/$$"; cat /dev/null > "$out"`);
    await Promise.all(Array.from({ length: 6 }, () => decryptPdf(input, { maxOutputBytes: 64 * KiB })));
    const seen = readFileSync(join(bin, 'seen'), 'utf8').trim().split('\n').map(Number);
    expect(seen).toHaveLength(6);
    expect(Math.max(...seen)).toBeLessThanOrEqual(QPDF_CONCURRENCY);
  });

  it('refuses as busy when no slot comes free in time', async () => {
    stub('sleep 0.5; cat /dev/null > "$out"');
    const runs = Array.from({ length: QPDF_CONCURRENCY + 1 }, () =>
      decryptPdf(input, { maxOutputBytes: 64 * KiB, queueMs: 50 }).then(() => 'ok', (e: unknown) => e),
    );
    const results = await Promise.all(runs);
    expect(results.filter((r) => r === 'ok')).toHaveLength(QPDF_CONCURRENCY);
    expect(results.filter((r) => r instanceof QpdfBusyError)).toHaveLength(1);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(QPDF_CONCURRENCY);
  });

  it('maps a password refusal to QpdfPasswordError', async () => {
    stub('echo "invalid password" >&2; exit 2');
    await expect(decryptPdf(input, { maxOutputBytes: 64 * KiB })).rejects.toBeInstanceOf(QpdfPasswordError);
  });

  it('maps a missing qpdf to QpdfMissingError', async () => {
    vi.stubEnv('PATH', mkdtempSync(join(work, 'empty-')));
    await expect(decryptPdf(input, { maxOutputBytes: 64 * KiB })).rejects.toBeInstanceOf(QpdfMissingError);
  });
});

describe.skipIf(!realQpdf)('decryptPdf with the real qpdf', () => {
  it('removes the encryption without decoding or re-encoding stream data', async () => {
    const bomb = doubleFlate(64 * 1024 * KiB);
    const encrypted = Buffer.from(await encryptedPdf('aes', { filter: ['FlateDecode', 'FlateDecode'], data: bomb }));
    const out = await decryptPdf(encrypted, { maxOutputBytes: 1024 * KiB });
    expect(out.length).toBeLessThan(encrypted.length + 4 * KiB);
    const doc = await PDFDocument.load(out);
    const extra = doc.context.lookup(doc.catalog.get(PDFName.of('Extra')));
    expect(extra).toBeInstanceOf(PDFRawStream);
    const stream = extra as PDFRawStream;
    expect(Buffer.from(stream.contents).equals(bomb)).toBe(true);
    const filter = stream.dict.lookup(PDFName.of('Filter'), PDFArray);
    expect(filter.asArray().map(String)).toEqual(['/FlateDecode', '/FlateDecode']);
  });
});
