import { test, expect, type Page, type Browser } from '@playwright/test';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument, StandardFonts, PDFName, PDFDict, PDFRawStream, PDFHexString, PDFString } from 'pdf-lib';
import {
  resolveBootstrapToken,
  waitForMailLink,
  toTestUrl,
  builderUploadAndContinue,
  builderAddRecipient,
  builderPlaceSignature,
  builderSend,
  recipientTypedSign,
  APP_CONTAINER,
} from './helpers';

const p = (path: string) => path.replace(/^\//, '');
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'CorrectHorseBatteryStaple-2026';

const appAlert = (page: Page) =>
  page.getByRole('alert')
    .and(page.locator(':not(#__next-route-announcer__)'))
    // Sonner error toasts carry data-type instead of role="alert".
    .or(page.locator('[data-sonner-toast][data-type="error"]'));

async function makePdfBytes(text = 'Phase 4'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 50, y: 250, size: 16, font });
  return doc.save();
}

async function ensureLoggedInAsAdmin(page: Page) {
  await page.goto(p('/login'));
  if (page.url().endsWith('/dashboard')) return;
  const setupRes = await page.request.get(p('/setup'));
  if (setupRes.status() !== 404) {
    const token = await resolveBootstrapToken();
    await page.goto(p('/setup'));
    await page.getByLabel('Bootstrap token').fill(token);
    await page.getByLabel('Administrator password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: /complete setup/i }).click();
    await expect(appAlert(page)).toContainText(/setup complete/i);
  }
  await page.goto(p('/login'));
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

async function recipientSigns(browser: Browser, link: string, name: string) {
  const ctx = await browser.newContext();
  const rp = await ctx.newPage();
  await rp.goto(toTestUrl(link));
  await recipientTypedSign(rp, name);
  await ctx.close();
}

/**
 * Locate the embedded `docuridge-manifest.json` attachment's raw (still
 * FlateDecode-compressed) stream inside a sealed PDF, via the exact
 * catalog Names/EmbeddedFiles traversal `scripts/verify.ts`'s
 * `extractManifest` uses. Returns the PDFRawStream so a caller can mutate
 * `.contents` directly and re-save — a deterministic, targeted tamper of
 * the manifest itself, rather than a byte flip at a random file offset.
 */
async function findManifestStream(doc: PDFDocument): Promise<PDFRawStream | null> {
  const catalog = doc.catalog;
  const namesDict = catalog.lookup(PDFName.of('Names'), PDFDict);
  if (!namesDict) return null;
  const embeddedFilesNameTree = namesDict.lookup(PDFName.of('EmbeddedFiles'), PDFDict);
  if (!embeddedFilesNameTree) return null;
  const namesArrRef = embeddedFilesNameTree.get(PDFName.of('Names'));
  const namesArr: any = (namesArrRef && typeof (namesArrRef as any).asArray === 'function')
    ? (namesArrRef as any)
    : doc.context.lookup(namesArrRef as any);
  if (!namesArr || typeof namesArr.asArray !== 'function') return null;
  const arr: any[] = namesArr.asArray();
  for (let i = 0; i < arr.length; i += 2) {
    const nameVal = arr[i];
    let filename: string | null = null;
    if (nameVal instanceof PDFHexString) {
      try { filename = (nameVal as any).decodeText?.() ?? null; } catch { /* fall through */ }
    } else if (nameVal instanceof PDFString) {
      filename = nameVal.decodeText();
    } else if (nameVal && typeof nameVal.asString === 'function') {
      filename = nameVal.asString();
    }
    if (!filename || !filename.startsWith('docuridge-manifest')) continue;

    const filespec = arr[i + 1];
    const filespecDict: PDFDict | undefined =
      filespec instanceof PDFDict ? filespec : (doc.context.lookup(filespec) as PDFDict | undefined);
    if (!filespecDict) continue;
    const efDict = filespecDict.lookup(PDFName.of('EF'), PDFDict);
    if (!efDict) continue;
    const fStreamRef = efDict.get(PDFName.of('F'));
    if (fStreamRef instanceof PDFRawStream) return fStreamRef;
    const looked: any = doc.context.lookup(fStreamRef as any);
    if (looked instanceof PDFRawStream) return looked;
  }
  return null;
}

function runVerify(filePath: string, extraArgs: string[] = []): { code: number; stdout: string; stderr: string } {
  // Run on the host where tsx + node_modules are available. The verify
  // script is fully self-contained and does not consult the database.
  try {
    const out = execSync(`npx tsx scripts/verify.ts ${extraArgs.join(' ')} ${filePath}`, {
      encoding: 'utf8',
      stdio: 'pipe',
      cwd: '/projects/DocuRidge',
    });
    return { code: 0, stdout: out, stderr: '' };
  } catch (err: any) {
    return {
      code: err.status ?? -1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
    };
  }
}

test.describe.serial('phase 4 — cryptographic hardening', () => {
  let sealedPath = '';
  // The org signing-key fingerprint, read from the dashboard (out of band
  // from the PDF): verify only passes against a key the caller pins.
  let orgFingerprint = '';

  test('sealed PDF carries a signed manifest; verify command passes', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);
    const ts = Date.now();
    const recipient = `phase4-${ts}@example.com`;

    await builderUploadAndContinue(page, {
      title: `Phase 4 ${ts}`,
      files: [{ name: 'p4.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await makePdfBytes()) }],
    });
    await builderAddRecipient(page, 'Sig Tester', recipient);
    await builderPlaceSignature(page);
    await builderSend(page);
    await expect(page).toHaveURL(/\/dashboard\/envelopes\/c[a-z0-9]{20,}$/);
    const envelopeId = new URL(page.url()).pathname.split('/').pop()!;

    const link = await waitForMailLink(recipient, /\/sign\//);
    expect(link).not.toBeNull();
    await recipientSigns(browser, link!, 'Sig Tester');

    await page.reload();
    // Friendly status pill replaces the raw badge.
    await expect(page.getByText(/^Completed$/).first()).toBeVisible({ timeout: 15000 });

    // Read the sealed PDF directly off the container's volume. Sidesteps
    // session-cookie + Secure-flag complications over plain HTTP. The
    // path layout is documented in src/lib/storage.ts: <SEALED_DIR>/<orgId>/<envelopeId>.pdf.
    const containerSealed = execSync(
      `docker exec ${APP_CONTAINER} sh -c 'ls /data/sealed/*/${envelopeId}.pdf'`,
      { encoding: 'utf8' },
    ).trim();
    const pdfBytes = execSync(`docker exec ${APP_CONTAINER} cat ${containerSealed}`, {
      encoding: 'buffer',
      maxBuffer: 100 * 1024 * 1024,
    });

    const dir = join(tmpdir(), 'docuridge-verify');
    mkdirSync(dir, { recursive: true });
    sealedPath = join(dir, `sealed-${ts}.pdf`);
    writeFileSync(sealedPath, pdfBytes);

    // The fingerprint lives in the envelope's Audit tab certificate panel.
    await page.goto(`${page.url().split('?')[0]}?tab=audit`);
    orgFingerprint = (await page.getByText('Certificate version · ed25519', { exact: true })
      .locator('xpath=following-sibling::p[1]').innerText()).trim();
    expect(orgFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // verify command should exit 0 against the pinned org key
    const result = runVerify(sealedPath, ['--fingerprint', orgFingerprint]);
    expect(result.code, `verify failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/VERIFY OK/);
    expect(result.stdout).toMatch(/manifest signature verified/);
    expect(result.stdout).toMatch(/audit event signature\(s\) verified/);
  });

  test('tampering with the embedded manifest makes verify fail with a named code', async () => {
    expect(sealedPath, 'previous test must produce a sealed PDF').toBeTruthy();
    const original = readFileSync(sealedPath);

    // Deterministic tamper: locate the docuridge-manifest.json attachment's
    // raw (FlateDecode-compressed) stream via the same catalog
    // Names/EmbeddedFiles traversal scripts/verify.ts uses, then flip one
    // byte inside THAT stream specifically. A byte flip at a random offset
    // in the whole file is not deterministic — measured behavior across 12
    // offsets found 3 that landed somewhere inert (whitespace, an
    // unreferenced object, or a spot pdf-lib tolerates) and slipped through
    // verification entirely. Flipping a byte inside a Flate-compressed
    // stream corrupts its zlib checksum, which is deterministic: probed 30
    // evenly-spaced offsets across a synthetic manifest attachment and all
    // 30 broke `zlib.inflateSync`, which verify.ts's extractManifest falls
    // through into a JSON.parse failure it does not catch internally — the
    // outer catch in main() reports it as `no_manifest`.
    const doc = await PDFDocument.load(original);
    const stream = await findManifestStream(doc);
    expect(stream, 'sealed PDF must carry a docuridge-manifest.json attachment').not.toBeNull();
    const contents = stream!.contents;
    const idx = Math.floor(contents.length / 2);
    contents[idx] = (contents[idx] ?? 0) ^ 0x55;
    const tampered = Buffer.from(await doc.save());
    const tamperedPath = sealedPath.replace(/\.pdf$/, '.tampered.pdf');
    writeFileSync(tamperedPath, tampered);

    const result = runVerify(tamperedPath, ['--fingerprint', orgFingerprint]);
    expect(result.code, `tampered verify expected non-zero, got ${result.code}\n${result.stdout}\n${result.stderr}`).not.toBe(0);
    // Named failure code, not merely /VERIFY FAILED/ — a verifier crash
    // (code 3, "verify: unexpected error") must NOT count as detection.
    expect(result.code).not.toBe(3);
    expect(result.stderr + result.stdout).toMatch(/code:\s+no_manifest/);
  });

  test('editing page content without touching the manifest makes verify fail', async () => {
    expect(sealedPath, 'first test must produce a sealed PDF').toBeTruthy();
    const original = readFileSync(sealedPath);

    // Unlike the byte-flip test above, this leaves the embedded manifest
    // completely untouched — only the rendered page content changes. Before
    // plan 005 this passed verify cleanly; it must now fail specifically on
    // the sealed-content digest check, not merely fail for some other reason.
    const doc = await PDFDocument.load(original);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.getPages()[0]!;
    page.drawText('TAMPERED', { x: 50, y: 200, size: 24, font });
    const contentTampered = Buffer.from(await doc.save());
    const contentTamperedPath = sealedPath.replace(/\.pdf$/, '.content-tampered.pdf');
    writeFileSync(contentTamperedPath, contentTampered);

    const result = runVerify(contentTamperedPath, ['--fingerprint', orgFingerprint]);
    expect(result.code, `content-tampered verify expected non-zero, got ${result.code}\n${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/sealed_content_digest/);
  });

  test('without a pinned key, verify reports UNTRUSTED and exits non-zero', async () => {
    expect(sealedPath, 'first test must produce a sealed PDF').toBeTruthy();
    const result = runVerify(sealedPath);
    expect(result.code).toBe(4);
    expect(result.stdout).toMatch(/VERIFY UNTRUSTED — key taken from the document/);
    expect(result.stdout).not.toMatch(/^VERIFY OK/m);
  });

  test('verify rejects the genuine PDF against a different pinned key', async () => {
    expect(sealedPath, 'first test must produce a sealed PDF').toBeTruthy();
    const result = runVerify(sealedPath, ['--fingerprint', '0'.repeat(64)]);
    expect(result.code).toBe(1);
    expect(result.stderr + result.stdout).toMatch(/code:\s+untrusted_key/);
  });

  test('verify on a non-DocuRidge PDF fails cleanly with no_manifest', async () => {
    const dir = join(tmpdir(), 'docuridge-verify');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `plain-${Date.now()}.pdf`);
    writeFileSync(path, Buffer.from(await makePdfBytes('not sealed')));
    const result = runVerify(path);
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/no_manifest|manifest_missing|no docuridge manifest/i);
  });
});
