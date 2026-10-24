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
} from './helpers';

const p = (path: string) => path.replace(/^\//, '');

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'CorrectHorseBatteryStaple-2026';

const appAlert = (page: import('@playwright/test').Page) =>
  page.getByRole('alert')
    .and(page.locator(':not(#__next-route-announcer__)'))
    // Sonner error toasts carry data-type instead of role="alert".
    .or(page.locator('[data-sonner-toast][data-type="error"]'));

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

/**
 * Add a recipient through the modal and set a per-recipient access code.
 * Mirrors builderAddRecipient, plus the optional code field in the modal.
 */
async function builderAddRecipientWithCode(
  page: import('@playwright/test').Page,
  name: string,
  email: string,
  accessCode: string,
): Promise<void> {
  await page.locator('[data-testid="builder-add-recipient"]').click();
  const modal = page.locator('[role="dialog"]');
  await modal.waitFor({ state: 'visible' });
  await modal.getByLabel('Name', { exact: true }).fill(name);
  await modal.getByLabel('Email', { exact: true }).fill(email);
  // The access-code input has no <label>; it's identified by its placeholder.
  await modal.getByPlaceholder(/letters or numbers/i).fill(accessCode);
  await modal.getByRole('button', { name: /^add recipient$/i }).click();
  await modal.waitFor({ state: 'hidden', timeout: 5000 });
}

/** Consent step of the ceremony (shared by the gated and control flows). */
async function consent(rp: import('@playwright/test').Page): Promise<void> {
  await rp.getByLabel(/i agree to use electronic records/i).check();
  await rp.getByRole('button', { name: /i agree, continue/i }).click();
}

/** Adopt a typed signature and finish — everything after unlock and consent. */
async function adoptAndFinish(rp: import('@playwright/test').Page, name: string): Promise<void> {
  const firstReq = rp.locator('button.sig-pulse').first();
  await firstReq.waitFor({ state: 'visible', timeout: 10000 });
  await firstReq.click();
  const modal = rp.locator('[role="dialog"]');
  await modal.waitFor({ state: 'visible' });
  await modal.getByRole('button', { name: /^type$/i }).click();
  await modal.getByPlaceholder(/type your full name/i).fill(name);
  await modal.getByRole('button', { name: /adopt.*sign/i }).click();
  await modal.waitFor({ state: 'hidden', timeout: 5000 });
  await rp.getByRole('button', { name: /finish.*submit/i }).click();
  await rp.getByRole('heading', { name: /document signed/i }).waitFor({ state: 'visible', timeout: 15000 });
}

test.skip(({ isMobile }) => isMobile, 'Admin/builder workflow — desktop viewport; mobile signing is covered by envelope/phase3/a11y suites');

test.describe.serial('access codes — gated ceremony', () => {
  const ACCESS_CODE = 'K7P2QX99';
  let detailUrl = '';

  test('wrong code errors generically, 5 wrong locks out, correct code unlocks and signs', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);

    const recipientEmail = `coded-${Date.now()}@example.com`;
    const envelopeTitle = `Access Code Envelope ${Date.now()}`;
    const pdfBytes = await makePdfBytes();

    await builderUploadAndContinue(page, {
      title: envelopeTitle,
      files: [{ name: 'access-code.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfBytes) }],
    });
    await builderAddRecipientWithCode(page, 'Coded Recipient', recipientEmail, ACCESS_CODE);
    await builderPlaceSignature(page);
    await builderSend(page);
    // builderSend's regex also matches /envelopes/new — wait for the real
    // redirect to the created envelope before capturing the detail URL.
    await expect(page).toHaveURL(/\/dashboard\/envelopes\/(?!new)[a-z0-9]+$/, { timeout: 30000 });
    detailUrl = page.url();
    await expect(page.getByRole('heading', { name: envelopeTitle })).toBeVisible();

    const signLink = await waitForMailLink(recipientEmail, /\/sign\//);
    expect(signLink, 'Signing link must be present in MailHog').not.toBeNull();

    const recipientCtx = await browser.newContext();
    const rp = await recipientCtx.newPage();
    await rp.goto(toTestUrl(signLink!));

    // The gate comes first and is enforced server-side: the page carries no
    // envelope data yet, and the document route refuses the bare link.
    await expect(rp.getByRole('heading', { name: 'Enter your access code' })).toBeVisible();
    await expect(rp.getByText(envelopeTitle)).toHaveCount(0);
    const docUrl = `${toTestUrl(signLink!).replace(/\/$/, '')}/document`;
    expect((await rp.request.get(docUrl)).status()).toBe(403);

    const codeInput = rp.locator('input[name="code"]');
    const unlockButton = rp.getByRole('button', { name: /unlock document/i });
    // Next's route announcer also exposes role="alert" — scope to the form error.
    const formAlert = rp.getByRole('alert').and(rp.locator(':not(#__next-route-announcer__)'));

    // A wrong code fails with the generic error (no oracle about the code).
    await codeInput.fill('ZZZZ99');
    await unlockButton.click();
    await expect(formAlert).toContainText(/incorrect access code/i);
    await expect(unlockButton).toBeEnabled();

    // Four more wrong attempts: the 5th failure trips the per-recipient
    // lockout even though the per-IP bucket still has headroom.
    for (let i = 0; i < 4; i++) {
      await codeInput.fill(`BADCODE${i}`);
      await unlockButton.click();
      await expect(unlockButton).toBeEnabled();
    }
    await expect(formAlert).toContainText(/too many incorrect attempts/i);

    // The correct code still unlocks (the lockout only gates failures).
    await codeInput.fill(ACCESS_CODE);
    await unlockButton.click();
    // The page re-renders server-side with the ceremony; consent follows.
    await consent(rp);
    await expect(rp.getByRole('heading', { name: 'Required fields' })).toBeVisible();
    expect((await rp.request.get(docUrl)).status()).toBe(200);

    await adoptAndFinish(rp, 'Coded Recipient');
    await recipientCtx.close();

    // ── Audit: the unlock event is visible in the envelope activity ──
    await page.goto(detailUrl);
    await page.getByRole('link', { name: /^activity$/i }).click();
    await expect(page.getByText(/unlocked the document with an access code/i)).toBeVisible();
  });
});

test.describe('access codes — control case', () => {
  test('recipient without a code never sees the unlock step', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);

    const recipientEmail = `nocode-${Date.now()}@example.com`;
    const envelopeTitle = `No Access Code ${Date.now()}`;
    const pdfBytes = await makePdfBytes();

    await builderUploadAndContinue(page, {
      title: envelopeTitle,
      files: [{ name: 'no-access-code.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfBytes) }],
    });
    // Standard helper — no access code set.
    await builderAddRecipient(page, 'Plain Recipient', recipientEmail);
    await builderPlaceSignature(page);
    await builderSend(page);

    const signLink = await waitForMailLink(recipientEmail, /\/sign\//);
    expect(signLink).not.toBeNull();

    const recipientCtx = await browser.newContext();
    const rp = await recipientCtx.newPage();
    await rp.goto(toTestUrl(signLink!));

    await consent(rp);
    // Directly after consent the signing stage renders — no unlock gate.
    await expect(rp.getByRole('heading', { name: 'Enter your access code' })).toHaveCount(0);
    await expect(rp.getByRole('heading', { name: 'Required fields' })).toBeVisible();

    await adoptAndFinish(rp, 'Plain Recipient');
    await recipientCtx.close();
  });
});
