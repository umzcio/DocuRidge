import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { resolveBootstrapToken, waitForMailLink, toTestUrl } from './helpers';

const p = (path: string) => path.replace(/^\//, '');

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'CorrectHorseBatteryStaple-2026';

const appAlert = (page: import('@playwright/test').Page) =>
  page.getByRole('alert').and(page.locator(':not(#__next-route-announcer__)'));

async function makePdfBytes(text = 'Hello DocuRidge'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 50, y: 700, size: 20, font });
  page.drawText('Sign here:', { x: 50, y: 200, size: 12, font });
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

test.describe.serial('envelope flow — happy path', () => {
  test('admin creates an envelope, recipient signs, sealed PDF appears', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);

    const recipientEmail = `recipient-${Date.now()}@example.com`;
    const envelopeTitle = `E2E Envelope ${Date.now()}`;

    // Create envelope
    await page.goto(p('/dashboard/envelopes/new'));
    await page.getByLabel('Title').fill(envelopeTitle);
    await page.getByLabel('Name', { exact: true }).fill('E2E Recipient');
    await page.getByLabel('Email', { exact: true }).fill(recipientEmail);

    // Upload PDF
    const pdfBytes = await makePdfBytes();
    const fileInput = page.locator('input[type=file]');
    await fileInput.setInputFiles({
      name: 'e2e.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(pdfBytes),
    });

    // Place a signature field via the form helper
    await page.getByRole('button', { name: /\+ add field/i }).click();
    await expect(page.getByText(/SIGNATURE · page 1/i)).toBeVisible();

    // Send
    await page.getByRole('button', { name: /create & send envelope/i }).click();

    // Land on detail page
    await expect(page).toHaveURL(/\/dashboard\/envelopes\/[a-z0-9]+$/);
    await expect(page.getByRole('heading', { name: envelopeTitle })).toBeVisible();
    await expect(page.getByText(/IN PROGRESS|SENT/)).toBeVisible();

    // Recipient receives the signing link (poll because mailhog can lag).
    const signLink = await waitForMailLink(recipientEmail, /\/sign\//);
    expect(signLink, 'Signing link must be present in MailHog').not.toBeNull();

    // Use a separate browser context for the recipient (no admin session)
    const recipientCtx = await browser.newContext();
    const recipientPage = await recipientCtx.newPage();
    await recipientPage.goto(toTestUrl(signLink!));

    // Consent
    await expect(recipientPage.getByRole('heading', { name: /before you sign/i })).toBeVisible();
    await recipientPage.getByLabel(/i agree to use electronic records/i).check();
    await recipientPage.getByRole('button', { name: /i agree, continue/i }).click();

    // Type signature
    await recipientPage.getByLabel(/typed signature/i).fill('E2E Recipient');

    // Confirm and sign
    await recipientPage.getByRole('button', { name: /confirm and sign/i }).click();
    await expect(appAlert(recipientPage)).toContainText(/document complete|signed/i);

    await recipientCtx.close();

    // Admin reloads and sees COMPLETED + sealed download link
    await page.reload();
    await expect(page.getByText(/^COMPLETED$/)).toBeVisible();
    await expect(page.getByText(/sealed and complete/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /download sealed pdf/i })).toBeVisible();

    // Audit timeline includes envelope.sealed and recipient.signed
    await expect(page.getByText('envelope.sealed')).toBeVisible();
    await expect(page.getByText('recipient.signed')).toBeVisible();
  });
});

test.describe('envelope flow — negative paths', () => {
  test('non-PDF upload is rejected', async ({ page }) => {
    await ensureLoggedInAsAdmin(page);
    await page.goto(p('/dashboard/envelopes/new'));
    await page.getByLabel('Title').fill('Non-PDF test');
    await page.getByLabel('Name', { exact: true }).fill('R');
    await page.getByLabel('Email', { exact: true }).fill(`r-${Date.now()}@example.com`);

    await page.locator('input[type=file]').setInputFiles({
      name: 'evil.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('this is not a pdf'),
    });
    await page.getByRole('button', { name: /\+ add field/i }).click();
    await page.getByRole('button', { name: /create & send envelope/i }).click();
    await expect(appAlert(page)).toContainText(/does not look like a pdf|not a pdf/i);
  });

  test('reused signing token is rejected', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);

    const recipientEmail = `dup-${Date.now()}@example.com`;
    const envelopeTitle = `Dup Token Test ${Date.now()}`;

    await page.goto(p('/dashboard/envelopes/new'));
    await page.getByLabel('Title').fill(envelopeTitle);
    await page.getByLabel('Name', { exact: true }).fill('Dup R');
    await page.getByLabel('Email', { exact: true }).fill(recipientEmail);

    const pdfBytes = await makePdfBytes();
    await page.locator('input[type=file]').setInputFiles({
      name: 'dup.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(pdfBytes),
    });
    await page.getByRole('button', { name: /\+ add field/i }).click();
    await page.getByRole('button', { name: /create & send envelope/i }).click();
    await expect(page).toHaveURL(/\/dashboard\/envelopes\/[a-z0-9]+$/);

    const link = await waitForMailLink(recipientEmail, /\/sign\//);
    expect(link).not.toBeNull();

    // First open + sign
    const ctx1 = await browser.newContext();
    const p1 = await ctx1.newPage();
    await p1.goto(toTestUrl(link!));
    await p1.getByLabel(/i agree to use electronic records/i).check();
    await p1.getByRole('button', { name: /i agree, continue/i }).click();
    await p1.getByLabel(/typed signature/i).fill('Dup R');
    await p1.getByRole('button', { name: /confirm and sign/i }).click();
    await expect(appAlert(p1)).toContainText(/document complete|signed/i);
    await ctx1.close();

    // Second attempt — same token, recipient already signed → "recipient_done"
    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    await p2.goto(toTestUrl(link!));
    await expect(p2.getByText(/already signed|already used|no longer awaiting/i)).toBeVisible();
    await ctx2.close();
  });

  test('garbage signing token is rejected', async ({ page }) => {
    await page.goto(p('/sign/garbage'));
    await expect(page.getByText(/signing link is invalid/i)).toBeVisible();
  });
});
