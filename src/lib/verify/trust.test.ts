import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import { normalizeFingerprint, parsePublicKeyFile, verifySealedPdf } from './sealed-pdf';
import { buildSealedPdf, makeTestKey, type TestKey } from './__fixtures__/sealed-pdf';
import { appendIncrementalUpdate, forgedContentStream, pageContentRef, serialize } from './__fixtures__/pdf-surgery';
import { publicKeyFromPem } from '../audit/canonical';

/**
 * A forger re-signs a sealed PDF with a fresh Ed25519 key and embeds that
 * key in the manifest. Only a key obtained independently of the PDF can tell
 * the two apart.
 */
describe('verifySealedPdf — trust anchor', () => {
  let orgKey: TestKey;
  let forgerKey: TestKey;
  let genuine: Uint8Array;
  let forged: Uint8Array;

  beforeAll(async () => {
    orgKey = await makeTestKey();
    forgerKey = await makeTestKey();
    genuine = await buildSealedPdf({ key: orgKey });
    forged = await buildSealedPdf({ key: forgerKey });
  });

  it('accepts a genuine seal against the pinned org fingerprint', async () => {
    const result = await verifySealedPdf(genuine, {
      trust: { publicKeys: [], fingerprints: [orgKey.fingerprint], source: '--fingerprint' },
    });
    expect(result.ok, result.reason).toBe(true);
    expect(result.keyTrusted).toBe(true);
    expect(result.keySource).toBe('--fingerprint');
  });

  it('accepts a genuine seal against the pinned org public key', async () => {
    const result = await verifySealedPdf(genuine, {
      trust: { publicKeys: [publicKeyFromPem(orgKey.publicKeyPem)], fingerprints: [], source: '--key org.pem' },
    });
    expect(result.ok, result.reason).toBe(true);
    expect(result.keyTrusted).toBe(true);
  });

  it('rejects a PDF re-signed with a fresh key, with a distinct code', async () => {
    const result = await verifySealedPdf(forged, {
      trust: { publicKeys: [], fingerprints: [orgKey.fingerprint], source: '--fingerprint' },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('untrusted_key');
    expect(result.reason).toContain(forgerKey.fingerprint);
  });

  it('without a trust anchor, passes the checks but never marks the key trusted', async () => {
    const result = await verifySealedPdf(forged);
    expect(result.ok).toBe(true);
    expect(result.keyTrusted).toBe(false);
    expect(result.keySource).toBe('embedded in the document (untrusted)');
    expect(result.embeddedFingerprint).toBe(forgerKey.fingerprint);
  });

  it('rejects a manifest whose declared fingerprint does not match its embedded key', async () => {
    const mislabeled = await buildSealedPdf({ key: { ...forgerKey, fingerprint: orgKey.fingerprint } });
    const result = await verifySealedPdf(mislabeled);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('fingerprint_mismatch');
  });
});

describe('trust anchor parsing', () => {
  it('normalizes fingerprints written with colons, spaces or upper case', () => {
    const fp = 'ab'.repeat(32);
    expect(normalizeFingerprint(fp.toUpperCase().match(/../g)!.join(':'))).toBe(fp);
    expect(normalizeFingerprint(` ${fp} `)).toBe(fp);
  });

  it('rejects a malformed fingerprint', () => {
    expect(() => normalizeFingerprint('abc')).toThrow(/fingerprint/i);
  });

  it('reads every PEM block in a key file (current and rotated keys)', async () => {
    const a = await makeTestKey();
    const b = await makeTestKey();
    const keys = parsePublicKeyFile(`${a.publicKeyPem}\n${b.publicKeyPem}`);
    expect(keys).toHaveLength(2);
    expect(Buffer.from(keys[1]!)).toEqual(Buffer.from(publicKeyFromPem(b.publicKeyPem)));
  });

  it('rejects a key file with no PEM block', () => {
    expect(() => parsePublicKeyFile('not a key')).toThrow(/no .*public key/i);
  });
});

describe('npm run verify (CLI) exit codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docuridge-verify-cli-'));
  const tsx = resolve(__dirname, '../../../node_modules/.bin/tsx');
  const script = resolve(__dirname, '../../../scripts/verify.ts');
  let orgKey: TestKey;
  const run = (args: string[], env: Record<string, string> = {}) => {
    try {
      const stdout = execFileSync(tsx, [script, ...args], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, DOCURIDGE_VERIFY_KEY_FILE: '', DOCURIDGE_VERIFY_FINGERPRINT: '', ...env },
      });
      return { code: 0, out: stdout };
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };

  beforeAll(async () => {
    orgKey = await makeTestKey();
    writeFileSync(join(dir, 'genuine.pdf'), await buildSealedPdf({ key: orgKey }));
    writeFileSync(join(dir, 'forged.pdf'), await buildSealedPdf({ key: await makeTestKey() }));
    writeFileSync(join(dir, 'org.pem'), orgKey.publicKeyPem);
    const legacy = await buildSealedPdf({ key: orgKey, legacyManifest: true });
    writeFileSync(join(dir, 'legacy.pdf'), legacy);
    writeFileSync(join(dir, 'digest-v2.pdf'), await buildSealedPdf({ key: orgKey, digestVersion: 2 }));
    const genuineBytes = await buildSealedPdf({ key: orgKey });
    const genuine = await PDFDocument.load(genuineBytes);
    const contentRef = pageContentRef(genuine);
    writeFileSync(join(dir, 'shadowed.pdf'), await appendIncrementalUpdate(genuineBytes, [
      { num: contentRef.objectNumber, body: forgedContentStream(genuine, 'VOID') },
      { num: contentRef.objectNumber, body: serialize(genuine.context.lookup(contentRef)!), listed: false },
    ]));
    const forgedBody = await PDFDocument.load(legacy);
    forgedBody.getPage(0).drawRectangle({ x: 40, y: 690, width: 250, height: 30, color: rgb(1, 1, 1) });
    writeFileSync(join(dir, 'legacy-forged-body.pdf'), await forgedBody.save());
    const plain = await PDFDocument.create();
    plain.addPage();
    writeFileSync(join(dir, 'plain.pdf'), await plain.save());
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('exits 4 and says UNTRUSTED when no trusted key is supplied', () => {
    const { code, out } = run([join(dir, 'genuine.pdf')]);
    expect(code).toBe(4);
    expect(out).toMatch(/UNTRUSTED — key taken from the document/);
    expect(out).not.toMatch(/^VERIFY OK/m);
  });

  it('exits 0 with VERIFY OK against --fingerprint', () => {
    const { code, out } = run(['--fingerprint', orgKey.fingerprint, join(dir, 'genuine.pdf')]);
    expect(code, out).toBe(0);
    expect(out).toMatch(/^VERIFY OK$/m);
    expect(out).toMatch(/trusted key:\s+--fingerprint/);
  });

  it('exits 0 against --key and against DOCURIDGE_VERIFY_KEY_FILE', () => {
    expect(run(['--key', join(dir, 'org.pem'), join(dir, 'genuine.pdf')]).code).toBe(0);
    expect(run([join(dir, 'genuine.pdf')], { DOCURIDGE_VERIFY_KEY_FILE: join(dir, 'org.pem') }).code).toBe(0);
  });

  it('exits 1 with untrusted_key for a PDF re-signed with a fresh key', () => {
    const { code, out } = run(['--fingerprint', orgKey.fingerprint, join(dir, 'forged.pdf')]);
    expect(code).toBe(1);
    expect(out).toMatch(/code:\s+untrusted_key/);
  });

  it('still reports no_manifest for a non-DocuRidge PDF', () => {
    const { code, out } = run(['--fingerprint', orgKey.fingerprint, join(dir, 'plain.pdf')]);
    expect(code).toBe(1);
    expect(out).toMatch(/code:\s+no_manifest/);
  });

  it('exits 5, not 0, for a legacy manifest that does not bind the document body', () => {
    const { code, out } = run(['--fingerprint', orgKey.fingerprint, join(dir, 'legacy.pdf')]);
    expect(code, out).toBe(5);
    expect(out).toMatch(/^VERIFY INCOMPLETE — LEGACY MANIFEST/m);
    expect(out).toMatch(/--allow-legacy-manifest/);
    expect(out).not.toMatch(/^VERIFY OK/m);
  });

  it('exits 5 for a legacy manifest lifted onto a forged body, even with a pinned key', () => {
    // The manifest is genuine and signed by the pinned key, but nothing in it
    // covers the page the forger replaced.
    const { code, out } = run(['--fingerprint', orgKey.fingerprint, join(dir, 'legacy-forged-body.pdf')]);
    expect(code, out).toBe(5);
    expect(out).not.toMatch(/^VERIFY OK/m);
  });

  it('exits 0 for a legacy manifest only with --allow-legacy-manifest', () => {
    const { code, out } = run(['--allow-legacy-manifest', '--fingerprint', orgKey.fingerprint, join(dir, 'legacy.pdf')]);
    expect(code, out).toBe(0);
    expect(out).toMatch(/^VERIFY OK — LEGACY MANIFEST \(v1\)/m);
    expect(out).toMatch(/document body NOT covered/);
  });

  it('still exits 4 for a legacy manifest with no trusted key, opt-in or not', () => {
    expect(run([join(dir, 'legacy.pdf')]).code).toBe(4);
    expect(run(['--allow-legacy-manifest', join(dir, 'legacy.pdf')]).code).toBe(4);
  });

  it('exits 1 with sealed_content_missing for a legacy manifest under --strict, even with the opt-in', () => {
    const { code, out } = run(['--strict', '--allow-legacy-manifest', '--fingerprint', orgKey.fingerprint, join(dir, 'legacy.pdf')]);
    expect(code).toBe(1);
    expect(out).toMatch(/code:\s+sealed_content_missing/);
  });

  it('keeps exit 0 for a current manifest when --allow-legacy-manifest is passed', () => {
    const { code, out } = run(['--allow-legacy-manifest', '--fingerprint', orgKey.fingerprint, join(dir, 'genuine.pdf')]);
    expect(code, out).toBe(0);
    expect(out).toMatch(/^VERIFY OK$/m);
  });

  it('exits 0 for a digest-v2 seal, labelled with its version', () => {
    const { code, out } = run(['--fingerprint', orgKey.fingerprint, join(dir, 'digest-v2.pdf')]);
    expect(code, out).toBe(0);
    expect(out).toMatch(/^VERIFY OK — DIGEST v2: /m);
    expect(out).toMatch(/digest version 2\)/);
  });

  it('exits 1 with sealed_content_legacy_digest for a digest-v2 seal under --strict', () => {
    const { code, out } = run(['--strict', '--fingerprint', orgKey.fingerprint, join(dir, 'digest-v2.pdf')]);
    expect(code, out).toBe(1);
    expect(out).toMatch(/code:\s+sealed_content_legacy_digest/);
  });

  it('exits 0 for a current (v3) seal under --strict', () => {
    const { code, out } = run(['--strict', '--fingerprint', orgKey.fingerprint, join(dir, 'genuine.pdf')]);
    expect(code, out).toBe(0);
    expect(out).toMatch(/^VERIFY OK$/m);
  });

  it('exits 1 with post_seal_revision for an incremental update that shadows page content', () => {
    const { code, out } = run(['--fingerprint', orgKey.fingerprint, join(dir, 'shadowed.pdf')]);
    expect(code, out).toBe(1);
    expect(out).toMatch(/code:\s+post_seal_revision/);
    expect(out).not.toMatch(/^VERIFY OK/m);
  });

  it('exits 2 on a malformed --fingerprint', () => {
    expect(run(['--fingerprint', 'nope', join(dir, 'genuine.pdf')]).code).toBe(2);
  });
});
