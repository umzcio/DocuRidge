import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  resolveBootstrapToken,
  waitForMailLink,
  toTestUrl,
  builderUploadAndContinue,
  builderAddRecipient,
  builderPlaceSignature,
  builderSend,
  recipientTypedSign,
} from './helpers';

const p = (path: string) => path.replace(/^\//, '');

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'CorrectHorseBatteryStaple-2026';

const appAlert = (page: import('@playwright/test').Page) =>
  page.getByRole('alert')
    .and(page.locator(':not(#__next-route-announcer__)'))
    // Sonner error toasts carry data-type instead of role="alert".
    .or(page.locator('[data-sonner-toast][data-type="error"]'));

/** Sonner success toast — each correction operation confirms via toast.
 *  Toasts stack while previous ones fade, so filter by text. */
const appToast = (page: import('@playwright/test').Page, pattern: RegExp) =>
  page.locator('[data-sonner-toast][data-type="success"]').filter({ hasText: pattern });

async function makePdfBytes(text = 'Hello DocuRidge'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // Short page so the rendered preview fits inside the viewport in tests —
  // position-based clicks then resolve to predictable viewport coords.
  const page = doc.addPage([612, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 50, y: 250, size: 20, font });
  page.drawText('Sign here:', { x: 50, y: 100, size: 12, font });
  return doc.save();
}

async function ensureLoggedInAsAdmin(page: import('@playwright/test').Page) {
  await page.goto(p('/login'));
  if (page.url().endsWith('/dashboard')) return;
  // If bootstrap not done, do it.
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

test.skip(({ isMobile }) => isMobile, 'Admin/builder workflow — desktop viewport; mobile signing is covered by envelope/phase3/a11y suites');

test.describe.serial('envelope correction', () => {
  test('message/expiration edit, add, replace (old link dies), remove — all audited', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);

    const stamp = Date.now();
    const r1Email = `corr-r1-${stamp}@example.com`;
    const r2Email = `corr-r2-${stamp}@example.com`;
    const r2NewEmail = `corr-r2b-${stamp}@example.com`;
    const r3Email = `corr-r3-${stamp}@example.com`;
    const envelopeTitle = `Correction ${stamp}`;
    const correctedMessage = `Corrected message ${stamp}`;
    // The builder defaults to a 30-day expiry — pick a clearly different day
    // so the expiration change records its own envelope.corrected event.
    const expiration = new Date(Date.now() + 60 * 86400_000).toISOString().slice(0, 10);
    const pdfBytes = await makePdfBytes();

    // ── Send a sequential envelope to two signers ──────────────────
    await builderUploadAndContinue(page, {
      title: envelopeTitle,
      files: [{ name: 'correction.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfBytes) }],
    });
    // Routing defaults to sequential; each signer gets a signature field.
    await builderAddRecipient(page, 'Corr One', r1Email);
    await builderPlaceSignature(page, 0, { x: 80, y: 80 });
    await builderAddRecipient(page, 'Corr Two', r2Email); // becomes active
    await builderPlaceSignature(page, 0, { x: 80, y: 190 });
    await builderSend(page);
    // builderSend's regex also matches /envelopes/new — wait for the real
    // redirect to the created envelope before capturing the detail URL.
    await expect(page).toHaveURL(/\/dashboard\/envelopes\/(?!new)[a-z0-9]+$/, { timeout: 30000 });
    const detailUrl = page.url();
    await expect(page.getByRole('heading', { name: envelopeTitle })).toBeVisible();

    // ── First recipient signs → envelope IN_PROGRESS ───────────────
    const r1Link = await waitForMailLink(r1Email, /\/sign\//);
    expect(r1Link).not.toBeNull();
    const r1Ctx = await browser.newContext();
    const r1p = await r1Ctx.newPage();
    await r1p.goto(toTestUrl(r1Link!));
    await recipientTypedSign(r1p, 'Corr One');
    await r1Ctx.close();

    // In sequential routing the second invite goes out once the first signs.
    const r2OldLink = await waitForMailLink(r2Email, /\/sign\//);
    expect(r2OldLink, 'Second recipient must receive the your-turn invite').not.toBeNull();

    // ── Correct: message + expiration ──────────────────────────────
    await page.goto(detailUrl);
    await page.getByRole('button', { name: /^correct$/i }).click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.getByRole('heading', { name: 'Correct envelope' })).toBeVisible();

    await dialog.locator('textarea[name="message"]').fill(correctedMessage);
    await dialog.locator('input[name="expiration"]').fill(expiration);
    await dialog.getByRole('button', { name: /^save changes$/i }).click();
    await expect(appToast(page, /envelope corrected/i)).toBeVisible();

    // ── Correct: add a third recipient ─────────────────────────────
    await dialog.getByPlaceholder('Jane Doe').fill('Corr Three');
    await dialog.getByPlaceholder('jane@example.edu').fill(r3Email);
    await dialog.getByRole('button', { name: /^add$/i }).click();
    await expect(appToast(page, /added corr three/i)).toBeVisible();

    // ── Correct: replace the second recipient ──────────────────────
    const r2Row = dialog.locator('li').filter({ hasText: r2Email });
    await r2Row.locator('input[name="email"]').fill(r2NewEmail);
    await r2Row.getByRole('button', { name: /^replace$/i }).click();
    await expect(appToast(page, /replaced/i)).toBeVisible();

    // The replaced recipient's old signing link must be dead.
    const deadCtx = await browser.newContext();
    const deadPage = await deadCtx.newPage();
    await deadPage.goto(toTestUrl(r2OldLink!));
    await expect(deadPage.getByText(/already been used/i)).toBeVisible();
    await deadCtx.close();

    // The new recipient received a working link.
    const r2NewLink = await waitForMailLink(r2NewEmail, /\/sign\//);
    expect(r2NewLink, 'Replaced recipient must receive a fresh invite').not.toBeNull();
    const newCtx = await browser.newContext();
    const newPage = await newCtx.newPage();
    await newPage.goto(toTestUrl(r2NewLink!));
    await expect(newPage.getByRole('heading', { name: /electronic signature consent/i })).toBeVisible();
    await newCtx.close();

    // ── Correct: remove a pending recipient ────────────────────────
    const r3Row = dialog.locator('li').filter({ hasText: r3Email });
    await r3Row.getByRole('button', { name: /remove recipient/i }).click();
    await expect(appToast(page, /removed corr three/i)).toBeVisible();

    // ── Signed recipient offers no replace/remove affordance ───────
    const r1Row = dialog.locator('li').filter({ hasText: r1Email });
    await expect(r1Row.getByText(/signed/i)).toBeVisible();
    await expect(r1Row.getByRole('button', { name: /^replace$/i })).toHaveCount(0);
    await expect(r1Row.getByRole('button', { name: /remove recipient/i })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // ── Message edit is visible on the detail page ─────────────────
    await expect(page.locator('#detail-main').getByText(correctedMessage)).toBeVisible();

    // ── Every operation landed in the audit activity ───────────────
    // updateDetails records one event per changed field (message AND
    // expiration) + addRecipient + replaceRecipient + removeRecipient.
    await page.getByRole('link', { name: /^activity$/i }).click();
    await expect(page.locator('#detail-main').getByText(/corrected the envelope/i)).toHaveCount(5);
  });
});
