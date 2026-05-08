import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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
 * Returns the decrypted bytes. Caller is responsible for replacing the
 * original buffer before persisting.
 */
export async function decryptPdf(input: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'docuridge-qpdf-'));
  const inPath = join(dir, 'in.pdf');
  const outPath = join(dir, 'out.pdf');
  try {
    await writeFile(inPath, input);
    try {
      await execFileAsync('qpdf', ['--decrypt', inPath, outPath], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024 * 64,
      });
    } catch (err) {
      const errno = (err as { code?: string }).code;
      if (errno === 'ENOENT') throw new QpdfMissingError();
      const stderr = (err as { stderr?: string }).stderr ?? '';
      // qpdf exits non-zero with a clear message on user-password PDFs.
      // 'invalid password' / 'requires a password' / etc.
      if (/password|encrypt|protected/i.test(stderr)) {
        throw new QpdfPasswordError(stderr.trim());
      }
      throw err;
    }
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
