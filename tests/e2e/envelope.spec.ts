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

test.describe.serial('envelope flow — happy path', () => {
  test('admin creates an envelope, recipient signs, sealed PDF appears', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);

    const recipientEmail = `recipient-${Date.now()}@example.com`;
    const envelopeTitle = `E2E Envelope ${Date.now()}`;
    const pdfBytes = await makePdfBytes();

    await builderUploadAndContinue(page, {
      title: envelopeTitle,
      files: [{ name: 'e2e.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfBytes) }],
    });
    await builderAddRecipient(page, 'E2E Recipient', recipientEmail);
    await builderPlaceSignature(page);
    await builderSend(page);

    // Land on detail page
    await expect(page.getByRole('heading', { name: envelopeTitle })).toBeVisible();

    // Recipient receives the signing link
    const signLink = await waitForMailLink(recipientEmail, /\/sign\//);
    expect(signLink, 'Signing link must be present in MailHog').not.toBeNull();

    const recipientCtx = await browser.newContext();
    const recipientPage = await recipientCtx.newPage();
    await recipientPage.goto(toTestUrl(signLink!));
    await recipientTypedSign(recipientPage, 'E2E Recipient');
    await recipientCtx.close();

    // Admin reloads — completed + sealed download visible
    await page.reload();
    await expect(page.getByRole('link', { name: /download/i }).first()).toBeVisible();
  });
});

test.describe('envelope flow — negative paths', () => {
  test('non-PDF upload is rejected', async ({ page }) => {
    await ensureLoggedInAsAdmin(page);
    await page.goto(p('/dashboard/envelopes/new'));
    await page.getByLabel('Add PDF documents').setInputFiles({
      name: 'evil.pdf', mimeType: 'application/pdf', buffer: Buffer.from('this is not a pdf'),
    });
    await expect(appAlert(page)).toContainText(/unable to open this pdf/i);
    await expect(page.getByText('evil.pdf', { exact: true })).not.toBeVisible();
  });

  test('reused signing token is rejected', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);

    const recipientEmail = `dup-${Date.now()}@example.com`;
    const envelopeTitle = `Dup Token Test ${Date.now()}`;
    const pdfBytes = await makePdfBytes();

    await builderUploadAndContinue(page, {
      title: envelopeTitle,
      files: [{ name: 'dup.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfBytes) }],
    });
    await builderAddRecipient(page, 'Dup R', recipientEmail);
    await builderPlaceSignature(page);
    await builderSend(page);

    const link = await waitForMailLink(recipientEmail, /\/sign\//);
    expect(link).not.toBeNull();

    const ctx1 = await browser.newContext();
    const p1 = await ctx1.newPage();
    await p1.goto(toTestUrl(link!));
    await recipientTypedSign(p1, 'Dup R');
    await ctx1.close();

    // Second attempt with same token — recipient already signed.
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

test.describe('envelope flow — multi-document', () => {
  test('two documents in one envelope, fields on each, both stamped in sealed PDF', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);

    const recipientEmail = `multi-${Date.now()}@example.com`;
    const envelopeTitle = `Multi-Doc Test ${Date.now()}`;

    const pdfA = await makePdfBytes('Document A');
    const pdfB = await makePdfBytes('Document B');

    await builderUploadAndContinue(page, {
      title: envelopeTitle,
      files: [
        { name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfA) },
        { name: 'b.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfB) },
      ],
    });
    await builderAddRecipient(page, 'Multi R', recipientEmail);

    // Place a signature on each document.
    await builderPlaceSignature(page, 0);
    await builderPlaceSignature(page, 1);
    await expect(page.getByRole('group', { name: /placed signature field/i })).toHaveCount(2);

    await builderSend(page);

    const signLink = await waitForMailLink(recipientEmail, /\/sign\//);
    expect(signLink).not.toBeNull();
    const ctx = await browser.newContext();
    const rp = await ctx.newPage();
    await rp.goto(toTestUrl(signLink!));
    await recipientTypedSign(rp, 'Multi R', async (signer) => {
      // The signer is shown every document, each with only its own field.
      const docA = signer.getByRole('region', { name: /^Document 1 of 2: a\.pdf$/ });
      const docB = signer.getByRole('region', { name: /^Document 2 of 2: b\.pdf$/ });
      for (const doc of [docA, docB]) {
        await expect(doc.getByText(/^1 page$/)).toBeVisible({ timeout: 15000 });
        await expect(doc.getByRole('button', { name: /^Signature field/ })).toHaveCount(1);
      }
      // Each section fetches its own PDF.
      const hrefs = await Promise.all(
        [docA, docB].map((d) => d.getByRole('link', { name: /open in new tab/i }).getAttribute('href')),
      );
      const bodies = await signer.evaluate(async (urls) => Promise.all(urls.map(async (u) => {
        const res = await fetch(u!, { credentials: 'same-origin' });
        return { status: res.status, bytes: Array.from(new Uint8Array(await res.arrayBuffer())).join(',') };
      })), hrefs);
      expect(bodies.map((b) => b.status)).toEqual([200, 200]);
      expect(bodies[0]!.bytes).not.toBe(bodies[1]!.bytes);
    });
    await ctx.close();

    await page.reload();
    await expect(page.getByRole('link', { name: /download/i }).first()).toBeVisible();
  });
});
