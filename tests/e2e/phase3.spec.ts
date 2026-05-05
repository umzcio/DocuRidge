import { test, expect, type Page, type Browser } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { resolveBootstrapToken, waitForMailLink, toTestUrl } from './helpers';

const p = (path: string) => path.replace(/^\//, '');

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'CorrectHorseBatteryStaple-2026';

const appAlert = (page: Page) =>
  page.getByRole('alert').and(page.locator(':not(#__next-route-announcer__)'));

async function makePdfBytes(text = 'Phase 3 test'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // Short page so the rendered preview fits inside the viewport in tests —
  // Playwright's position-based clicks then resolve to predictable viewport
  // coords without the wrap being scroll-clipped.
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

async function placeSignatureForActiveRecipient(page: Page, position = { x: 80, y: 80 }) {
  // Make absolutely sure no field is currently armed before we arm a fresh one.
  const armed = page.locator('[data-page-target][data-armed-type="SIGNATURE"]');
  if ((await armed.count()) > 0) {
    await page.keyboard.press('Escape');
  }
  const tile = page.locator('button[aria-label="Place a Signature field"]');
  await tile.click();
  await page.locator('[data-page-target][data-armed-type="SIGNATURE"]').first().waitFor({ state: 'visible', timeout: 10000 });
  const wrap = page.locator('[data-page-target][data-armed-type="SIGNATURE"]').first();
  await wrap.scrollIntoViewIfNeeded();
  await wrap.click({ position, force: true });
  // Confirm the placement disarmed before we proceed.
  await page.locator('[data-page-target]:not([data-armed-type="SIGNATURE"])').first().waitFor({ state: 'visible', timeout: 5000 });
}

async function recipientSignsTypedSignature(browser: Browser, link: string, name: string) {
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

test.describe.serial('phase 3 — multi-recipient sequential', () => {
  test('3-recipient sequential envelope flows through to completion', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);

    const ts = Date.now();
    const r1 = `seq1-${ts}@example.com`;
    const r2 = `seq2-${ts}@example.com`;
    const r3 = `seq3-${ts}@example.com`;

    await page.goto(p('/dashboard/envelopes/new'));
    await page.getByLabel('Title').fill(`Three-Way ${ts}`);

    // Each recipient block has a Name and Email input; the first block is index 0.
    const recipientNameInputs = page.getByRole('textbox', { name: 'Name' });
    const recipientEmailInputs = page.getByRole('textbox', { name: 'Email' });
    await recipientNameInputs.nth(0).fill('Alice');
    await recipientEmailInputs.nth(0).fill(r1);

    // Add 2 more recipients
    await page.getByRole('button', { name: /\+ add recipient/i }).click();
    await page.getByRole('button', { name: /\+ add recipient/i }).click();
    await recipientNameInputs.nth(1).fill('Bob');
    await recipientEmailInputs.nth(1).fill(r2);
    await recipientNameInputs.nth(2).fill('Carol');
    await recipientEmailInputs.nth(2).fill(r3);

    // Upload one PDF
    const pdfBytes = await makePdfBytes('Three-way agreement');
    await page.locator('input[type=file][accept="application/pdf"]').setInputFiles({
      name: 'three.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfBytes),
    });
    await expect(page.getByText(/three\.pdf · 1 page/i)).toBeVisible();

    // Place 3 signature fields (all for Alice initially), then reassign 2 to
    // Bob/Carol via the field-list recipient dropdown.
    await placeSignatureForActiveRecipient(page, { x: 80, y: 30 });
    await placeSignatureForActiveRecipient(page, { x: 280, y: 30 });
    await placeSignatureForActiveRecipient(page, { x: 80, y: 100 });

    await expect(page.getByRole('group', { name: /placed signature field/i })).toHaveCount(3);

    // Reassign field #2 to Bob and field #3 to Carol via the dropdowns.
    const reassignSelects = page.getByRole('combobox', { name: /reassign field to recipient/i });
    // selectOption by visible-text label.
    await reassignSelects.nth(1).selectOption({ label: '#2 Bob' });
    await reassignSelects.nth(2).selectOption({ label: '#3 Carol' });

    // Send
    await page.getByRole('button', { name: /create & send envelope/i }).click();
    await expect(page).toHaveURL(/\/dashboard\/envelopes\/[a-z0-9]+$/);
    await expect(page.getByText(/^IN PROGRESS$/)).toBeVisible();

    // Recipient 1 signs first; only r1 should have an email
    const link1 = await waitForMailLink(r1, /\/sign\//);
    expect(link1).not.toBeNull();
    await recipientSignsTypedSignature(browser, link1!, 'Alice');

    // Recipient 2 should now get an email
    const link2 = await waitForMailLink(r2, /\/sign\//);
    expect(link2).not.toBeNull();
    await recipientSignsTypedSignature(browser, link2!, 'Bob');

    // Recipient 3 last
    const link3 = await waitForMailLink(r3, /\/sign\//);
    expect(link3).not.toBeNull();
    await recipientSignsTypedSignature(browser, link3!, 'Carol');

    // Admin reloads, expects COMPLETED
    await page.reload();
    await expect(page.getByText(/^COMPLETED$/)).toBeVisible();
    await expect(page.getByRole('link', { name: /download sealed pdf/i })).toBeVisible();

    // Audit chain has the expected events
    await expect(page.getByText(/recipient.signed/).first()).toBeVisible();
    await expect(page.getByText(/envelope.completed/)).toBeVisible();
    await expect(page.getByText(/envelope.sealed/)).toBeVisible();
  });
});

test.describe('phase 3 — decline + void', () => {
  test('recipient can decline; envelope transitions to DECLINED', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);
    const ts = Date.now();
    const recipientEmail = `decliner-${ts}@example.com`;

    await page.goto(p('/dashboard/envelopes/new'));
    await page.getByLabel('Title').fill(`Decline Test ${ts}`);
    await page.getByRole('textbox', { name: 'Name' }).first().fill('Decliner');
    await page.getByRole('textbox', { name: 'Email' }).first().fill(recipientEmail);
    await page.locator('input[type=file][accept="application/pdf"]').setInputFiles({
      name: 'decline.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await makePdfBytes()),
    });
    await expect(page.getByText(/decline\.pdf · 1 page/i)).toBeVisible();
    await placeSignatureForActiveRecipient(page);
    await page.getByRole('button', { name: /create & send envelope/i }).click();
    await expect(page).toHaveURL(/\/dashboard\/envelopes\/[a-z0-9]+$/);

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
    await expect(appAlert(rp)).toContainText(/declined/i);
    await ctx.close();

    await page.reload();
    await expect(page.getByText(/^DECLINED$/).first()).toBeVisible();
    await expect(page.getByText(/recipient\.declined/)).toBeVisible();
  });

  test('sender can void an in-progress envelope', async ({ page }) => {
    await ensureLoggedInAsAdmin(page);
    const ts = Date.now();
    const recipientEmail = `voidee-${ts}@example.com`;

    await page.goto(p('/dashboard/envelopes/new'));
    await page.getByLabel('Title').fill(`Void Test ${ts}`);
    await page.getByRole('textbox', { name: 'Name' }).first().fill('Voidee');
    await page.getByRole('textbox', { name: 'Email' }).first().fill(recipientEmail);
    await page.locator('input[type=file][accept="application/pdf"]').setInputFiles({
      name: 'void.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await makePdfBytes()),
    });
    await expect(page.getByText(/void\.pdf · 1 page/i)).toBeVisible();
    await placeSignatureForActiveRecipient(page);
    await page.getByRole('button', { name: /create & send envelope/i }).click();
    await expect(page).toHaveURL(/\/dashboard\/envelopes\/[a-z0-9]+$/);

    // Void
    await page.getByRole('button', { name: /void envelope/i }).click();
    const dialog = page.getByRole('dialog', { name: /void this envelope/i });
    await dialog.getByRole('textbox', { name: /reason/i }).fill('Wrong recipient');
    await dialog.getByRole('button', { name: /^void envelope$/i }).click();

    await expect(page.getByText(/^VOIDED$/).first()).toBeVisible();
    await expect(page.getByText(/Voided: Wrong recipient/i)).toBeVisible();
    await expect(page.getByText(/envelope\.voided_by_sender/)).toBeVisible();
  });
});

test.describe('phase 3 — templates', () => {
  test('save existing envelope as template, instantiate it, send to a real recipient', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);
    const ts = Date.now();
    const r0 = `tplsource-${ts}@example.com`;
    const liveR = `tpllive-${ts}@example.com`;

    // Create the source envelope
    await page.goto(p('/dashboard/envelopes/new'));
    await page.getByLabel('Title').fill(`Source ${ts}`);
    await page.getByRole('textbox', { name: 'Name' }).first().fill('Manager');
    await page.getByRole('textbox', { name: 'Email' }).first().fill(r0);
    await page.locator('input[type=file][accept="application/pdf"]').setInputFiles({
      name: 'tpl.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await makePdfBytes('Template source')),
    });
    await expect(page.getByText(/tpl\.pdf · 1 page/i)).toBeVisible();
    await placeSignatureForActiveRecipient(page);
    await page.getByRole('button', { name: /create & send envelope/i }).click();
    await expect(page).toHaveURL(/\/dashboard\/envelopes\/[a-z0-9]+$/);

    // Save as template
    await page.getByRole('button', { name: /save as template/i }).click();
    await page.getByRole('textbox', { name: /template title/i }).fill(`Tpl ${ts}`);
    await page.getByRole('button', { name: /^save template$/i }).click();
    await expect(page).toHaveURL(/\/dashboard\/templates\/[a-z0-9]+$/);
    await expect(page.getByRole('heading', { name: `Tpl ${ts}` })).toBeVisible();

    // Fill role mapping with a live recipient and instantiate
    await page.getByRole('textbox', { name: 'Name' }).first().fill('Real Manager');
    await page.getByRole('textbox', { name: 'Email' }).first().fill(liveR);
    await page.getByRole('button', { name: /create envelope from template/i }).click();
    await expect(page).toHaveURL(/\/dashboard\/envelopes\/[a-z0-9]+$/);
    await expect(page.getByText(/^IN PROGRESS$/)).toBeVisible();

    // The instantiated envelope sends an invite to the live recipient
    const link = await waitForMailLink(liveR, /\/sign\//);
    expect(link).not.toBeNull();

    // Recipient signs
    await recipientSignsTypedSignature(browser, link!, 'Real Manager');

    await page.reload();
    await expect(page.getByText(/^COMPLETED$/)).toBeVisible();
  });
});

test.describe('phase 3 — dashboard filters', () => {
  test('status filter chips and search work', async ({ page }) => {
    await ensureLoggedInAsAdmin(page);
    await page.goto(p('/dashboard'));
    // Status chips render
    await expect(page.getByRole('link', { name: /^DRAFT$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^IN PROGRESS$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^COMPLETED$/ })).toBeVisible();

    // Search box submits and the URL has ?q=…
    await page.getByRole('searchbox').fill('does-not-exist-needle');
    await page.getByRole('button', { name: /^search$/i }).click();
    await expect(page).toHaveURL(/q=does-not-exist-needle/);
    // Empty state
    await expect(page.getByText(/no envelopes match/i)).toBeVisible();

    // Filter to COMPLETED
    await page.goto(p('/dashboard?status=COMPLETED'));
    await expect(page.getByRole('link', { name: /^COMPLETED$/ })).toBeVisible();
  });
});
