import { test, expect, type Page, type Browser } from '@playwright/test';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { resolveBootstrapToken, waitForMailLink, toTestUrl } from './helpers';

const p = (path: string) => path.replace(/^\//, '');
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'CorrectHorseBatteryStaple-2026';

const appAlert = (page: Page) =>
  page.getByRole('alert').and(page.locator(':not(#__next-route-announcer__)'));

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

async function placeSignature(page: Page, position = { x: 80, y: 30 }) {
  const armed = page.locator('[data-page-target][data-armed-type="SIGNATURE"]');
  if ((await armed.count()) > 0) await page.keyboard.press('Escape');
  await page.locator('button[aria-label="Place a Signature field"]').click();
  const wrap = page.locator('[data-page-target][data-armed-type="SIGNATURE"]').first();
  await wrap.waitFor({ state: 'visible', timeout: 10000 });
  await wrap.scrollIntoViewIfNeeded();
  await wrap.click({ position, force: true });
  await page.locator('[data-page-target]:not([data-armed-type="SIGNATURE"])').first().waitFor({ state: 'visible', timeout: 5000 });
}

async function recipientSigns(browser: Browser, link: string, name: string) {
  const ctx = await browser.newContext();
  const rp = await ctx.newPage();
  await rp.goto(toTestUrl(link));
  await rp.getByLabel(/i agree to use electronic records/i).check();
  await rp.getByRole('button', { name: /i agree, continue/i }).click();
  await rp.getByLabel(/typed signature/i).fill(name);
  await rp.getByRole('button', { name: /confirm and sign/i }).click();
  await expect(appAlert(rp)).toContainText(/document complete|signed/i);
  await ctx.close();
}

function runVerify(filePath: string): { code: number; stdout: string; stderr: string } {
  // Run on the host where tsx + node_modules are available. The verify
  // script is fully self-contained and does not consult the database.
  try {
    const out = execSync(`npx tsx scripts/verify.ts ${filePath}`, {
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

  test('sealed PDF carries a signed manifest; verify command passes', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);
    const ts = Date.now();
    const recipient = `phase4-${ts}@example.com`;

    await page.goto(p('/dashboard/envelopes/new'));
    await page.getByLabel('Title').fill(`Phase 4 ${ts}`);
    await page.getByRole('textbox', { name: 'Name' }).first().fill('Sig Tester');
    await page.getByRole('textbox', { name: 'Email' }).first().fill(recipient);
    await page.locator('input[type=file][accept="application/pdf"]').setInputFiles({
      name: 'p4.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await makePdfBytes()),
    });
    await expect(page.getByText(/p4\.pdf · 1 page/i)).toBeVisible();
    await placeSignature(page);
    await page.getByRole('button', { name: /create & send envelope/i }).click();
    await expect(page).toHaveURL(/\/dashboard\/envelopes\/c[a-z0-9]{20,}$/);
    const envelopeId = new URL(page.url()).pathname.split('/').pop()!;

    const link = await waitForMailLink(recipient, /\/sign\//);
    expect(link).not.toBeNull();
    await recipientSigns(browser, link!, 'Sig Tester');

    await page.reload();
    await expect(page.getByText(/^COMPLETED$/)).toBeVisible();

    // Read the sealed PDF directly off the container's volume. Sidesteps
    // session-cookie + Secure-flag complications over plain HTTP. The
    // path layout is documented in src/lib/storage.ts: <SEALED_DIR>/<orgId>/<envelopeId>.pdf.
    const containerSealed = execSync(
      `docker exec docuridge_app sh -c 'ls /data/sealed/*/${envelopeId}.pdf'`,
      { encoding: 'utf8' },
    ).trim();
    const pdfBytes = execSync(`docker exec docuridge_app cat ${containerSealed}`, {
      encoding: 'buffer',
      maxBuffer: 100 * 1024 * 1024,
    });

    const dir = join(tmpdir(), 'docuridge-verify');
    mkdirSync(dir, { recursive: true });
    sealedPath = join(dir, `sealed-${ts}.pdf`);
    writeFileSync(sealedPath, pdfBytes);

    // verify command should exit 0
    const result = runVerify(sealedPath);
    expect(result.code, `verify failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/VERIFY OK/);
    expect(result.stdout).toMatch(/manifest signature verified/);
    expect(result.stdout).toMatch(/audit event signature\(s\) verified/);
  });

  test('tampering with the sealed PDF makes verify fail', async () => {
    expect(sealedPath, 'previous test must produce a sealed PDF').toBeTruthy();
    const original = readFileSync(sealedPath);
    // The manifest is FlateDecode-compressed inside the PDF object stream,
    // so we can't search for plaintext markers. Flip a byte in the middle of
    // the file — that lands inside a stream and either (a) breaks the
    // compressed manifest, or (b) breaks the manifest content hash, or
    // (c) breaks the manifest signature. All three are caught by `verify`.
    const tampered = Buffer.from(original);
    const idx = Math.floor(tampered.length / 2);
    tampered[idx] = (tampered[idx] ?? 0) ^ 0x55;
    const tamperedPath = sealedPath.replace(/\.pdf$/, '.tampered.pdf');
    writeFileSync(tamperedPath, tampered);

    const result = runVerify(tamperedPath);
    expect(result.code, `tampered verify expected non-zero, got ${result.code}\n${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/VERIFY FAILED|verify: unexpected error/);
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
