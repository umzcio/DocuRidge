import { test, expect, type Page, type Browser } from '@playwright/test';
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

const appAlert = (page: Page) =>
  page.getByRole('alert').and(page.locator(':not(#__next-route-announcer__)'));

async function makePdfBytes(text = 'Phase 3 test'): Promise<Uint8Array> {
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

async function pickRecipientInLeftRail(page: Page, name: string) {
  await page.locator('aside button').filter({ hasText: name }).first().click();
}

async function recipientSignsAtLink(browser: Browser, link: string, name: string) {
  const ctx = await browser.newContext();
  const rp = await ctx.newPage();
  await rp.goto(toTestUrl(link));
  await recipientTypedSign(rp, name);
  await ctx.close();
}

test.describe.serial('phase 3 — multi-recipient sequential', () => {
  test('3-recipient sequential envelope flows through to completion', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);

    const ts = Date.now();
    const r1 = `seq1-${ts}@example.com`;
    const r2 = `seq2-${ts}@example.com`;
    const r3 = `seq3-${ts}@example.com`;

    const pdfBytes = await makePdfBytes('Three-way agreement');
    await builderUploadAndContinue(page, {
      title: `Three-Way ${ts}`,
      files: [{ name: 'three.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfBytes) }],
    });

    // Add three recipients in order. Each one becomes the active recipient on add.
    await builderAddRecipient(page, 'Alice', r1);
    await builderAddRecipient(page, 'Bob', r2);
    await builderAddRecipient(page, 'Carol', r3);

    // Place a signature for each — switch active recipient between placements.
    await pickRecipientInLeftRail(page, 'Alice');
    await builderPlaceSignature(page, 0, { x: 80, y: 30 });
    await pickRecipientInLeftRail(page, 'Bob');
    await builderPlaceSignature(page, 0, { x: 280, y: 30 });
    await pickRecipientInLeftRail(page, 'Carol');
    await builderPlaceSignature(page, 0, { x: 80, y: 100 });

    await expect(page.getByRole('group', { name: /placed signature field/i })).toHaveCount(3);

    await builderSend(page);

    // Sequential: only r1 gets the first email.
    const link1 = await waitForMailLink(r1, /\/sign\//);
    expect(link1).not.toBeNull();
    await recipientSignsAtLink(browser, link1!, 'Alice');

    const link2 = await waitForMailLink(r2, /\/sign\//);
    expect(link2).not.toBeNull();
    await recipientSignsAtLink(browser, link2!, 'Bob');

    const link3 = await waitForMailLink(r3, /\/sign\//);
    expect(link3).not.toBeNull();
    await recipientSignsAtLink(browser, link3!, 'Carol');

    // Admin reloads — completed + sealed download visible
    await page.reload();
    await expect(page.getByRole('link', { name: /download/i }).first()).toBeVisible();

    // Audit/Activity contains the expected event types
    await page.getByRole('link', { name: /^Activity$/ }).click();
    await expect(page.getByText(/signed the document/i).first()).toBeVisible();
  });
});

test.describe('phase 3 — decline + void', () => {
  test('recipient can decline; envelope transitions to DECLINED', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);
    const ts = Date.now();
    const recipientEmail = `decliner-${ts}@example.com`;

    await builderUploadAndContinue(page, {
      title: `Decline Test ${ts}`,
      files: [{ name: 'decline.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await makePdfBytes()) }],
    });
    await builderAddRecipient(page, 'Decliner', recipientEmail);
    await builderPlaceSignature(page);
    await builderSend(page);

    const link = await waitForMailLink(recipientEmail, /\/sign\//);
    expect(link).not.toBeNull();

    const ctx = await browser.newContext();
    const rp = await ctx.newPage();
    await rp.goto(toTestUrl(link!));
    await rp.getByLabel(/i agree to use electronic records/i).check();
    await rp.getByRole('button', { name: /i agree, continue/i }).click();
    await rp.getByRole('button', { name: /decline to sign/i }).click();
    await rp.getByRole('textbox', { name: /reason/i }).fill('Wrong document');
    await rp.getByRole('button', { name: /^decline$/i }).click();
    await rp.getByRole('heading', { name: /document declined/i }).waitFor({ state: 'visible', timeout: 10000 });
    await ctx.close();

    await page.reload();
    // Friendly "Declined" pill replaces the raw status badge. Anchored regex
    // avoids matching the lowercase verb in the activity log.
    await expect(page.getByText(/^Declined$/).first()).toBeVisible({ timeout: 10000 });
  });

  test('sender can void an in-progress envelope', async ({ page }) => {
    await ensureLoggedInAsAdmin(page);
    const ts = Date.now();
    const recipientEmail = `voidee-${ts}@example.com`;

    await builderUploadAndContinue(page, {
      title: `Void Test ${ts}`,
      files: [{ name: 'void.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await makePdfBytes()) }],
    });
    await builderAddRecipient(page, 'Voidee', recipientEmail);
    await builderPlaceSignature(page);
    await builderSend(page);

    // Void
    await page.getByRole('button', { name: /void document/i }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: /reason/i }).fill('Wrong recipient');
    await dialog.getByRole('button', { name: /^void document$/i }).click();

    await expect(page.getByText(/^Voided$/).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Voided: Wrong recipient/i)).toBeVisible();
  });
});

test.describe('phase 3 — templates', () => {
  test('save existing envelope as template, instantiate it, send to a real recipient', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);
    const ts = Date.now();
    const r0 = `tplsource-${ts}@example.com`;
    const liveR = `tpllive-${ts}@example.com`;

    // Create the source envelope
    await builderUploadAndContinue(page, {
      title: `Source ${ts}`,
      files: [{ name: 'tpl.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await makePdfBytes('Template source')) }],
    });
    await builderAddRecipient(page, 'Manager', r0);
    await builderPlaceSignature(page);
    await builderSend(page);

    // Save as template
    await page.getByRole('button', { name: /save as template/i }).click();
    await page.getByRole('textbox', { name: /template title/i }).fill(`Tpl ${ts}`);
    await page.getByRole('button', { name: /^save template$/i }).click();
    await expect(page).toHaveURL(/\/dashboard\/templates\/[a-z0-9]+$/);
    await expect(page.getByRole('heading', { name: `Tpl ${ts}` })).toBeVisible();

    // Fill role mapping with a live recipient and instantiate
    await page.getByRole('textbox', { name: 'Name' }).first().fill('Real Manager');
    await page.getByRole('textbox', { name: 'Email' }).first().fill(liveR);
    await page.getByRole('button', { name: /create document from template/i }).click();
    await expect(page).toHaveURL(/\/dashboard\/envelopes\/[a-z0-9]+$/);

    // The instantiated envelope sends an invite to the live recipient
    const link = await waitForMailLink(liveR, /\/sign\//);
    expect(link).not.toBeNull();

    await recipientSignsAtLink(browser, link!, 'Real Manager');

    await page.reload();
    await expect(page.getByRole('link', { name: /download/i }).first()).toBeVisible();
  });
});

test.describe('phase 3 — document list filters', () => {
  test('status dropdown and search work on /dashboard/envelopes', async ({ page }) => {
    await ensureLoggedInAsAdmin(page);
    await page.goto(p('/dashboard/envelopes'));

    // Status dropdown is present and selectable.
    const statusSelect = page.locator('select[name="status"]');
    await expect(statusSelect).toBeVisible();

    // Search box submits ?q=… via the in-page form.
    await page.getByPlaceholder(/search by name or recipient/i).fill('does-not-exist-needle');
    await page.getByRole('button', { name: /^apply$/i }).click();
    await expect(page).toHaveURL(/q=does-not-exist-needle/);
    await expect(page.getByText(/no documents found/i)).toBeVisible();

    // Selecting COMPLETED narrows to that status.
    await statusSelect.selectOption('COMPLETED');
    await page.getByRole('button', { name: /^apply$/i }).click();
    await expect(page).toHaveURL(/status=COMPLETED/);
  });
});
