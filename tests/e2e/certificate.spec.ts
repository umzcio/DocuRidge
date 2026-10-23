import { test, expect, request } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { BrowserContext } from '@playwright/test';
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
  // Short page so the rendered preview fits inside the viewport in tests.
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

/** Extract all text from a PDF via pdfjs — same reader as
 *  src/lib/completion-certificate.test.ts. */
async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  try {
    let out = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      out += content.items.map((it) => (it as { str: string }).str).join('\n') + '\n';
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

/**
 * Authenticated APIRequestContext for downloading artifacts (certificate PDF,
 * CSV export) from route handlers.
 *
 * NOTE: page.request / storageState cookie jars do NOT carry the app's
 * host-only session cookie here — the e2e stack runs on the 127.0.0.1 IP
 * literal and Playwright's jar silently drops it, so the route handler sees
 * an anonymous request and 302-redirects (to an absolute 0.0.0.0:3000 URL,
 * which then lands on an unrelated app). Sending the Cookie header
 * explicitly sidesteps the jar.
 */
async function authenticatedRequest(context: BrowserContext) {
  const cookies = await context.cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return request.newContext({
    extraHTTPHeaders: cookieHeader ? { cookie: cookieHeader } : {},
  });
}

async function buildAndSend(page: import('@playwright/test').Page, title: string, recipientEmail: string) {  const pdfBytes = await makePdfBytes();
  await builderUploadAndContinue(page, {
    title,
    files: [{ name: 'cert.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfBytes) }],
  });
  await builderAddRecipient(page, 'Cert Recipient', recipientEmail);
  await builderPlaceSignature(page);
  await builderSend(page);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

test.skip(({ isMobile }) => isMobile, 'Admin/builder workflow — desktop viewport; mobile signing is covered by envelope/phase3/a11y suites');

test.describe.serial('completion certificate', () => {
  test('completed envelope offers a Certificate link whose PDF names title, signer, and heading', async ({
    page,
    context,
    browser,
  }) => {
    await ensureLoggedInAsAdmin(page);

    const recipientEmail = `cert-${Date.now()}@example.com`;
    const envelopeTitle = `E2E Certificate ${Date.now()}`;
    await buildAndSend(page, envelopeTitle, recipientEmail);

    // Recipient signs via the typed-sign flow.
    const signLink = await waitForMailLink(recipientEmail, /\/sign\//);
    expect(signLink, 'Signing link must be present in MailHog').not.toBeNull();
    const recipientCtx = await browser.newContext();
    const recipientPage = await recipientCtx.newPage();
    await recipientPage.goto(toTestUrl(signLink!));
    await recipientTypedSign(recipientPage, 'Cert Recipient');
    await recipientCtx.close();

    // Detail page now offers the Certificate link next to the sealed Download.
    await page.reload();
    const certLink = page.getByRole('link', { name: 'Certificate', exact: true });
    await expect(certLink).toBeVisible();

    // Download through an authenticated request context and check the bytes.
    const href = await certLink.getAttribute('href');
    expect(href).toMatch(/\/certificate$/);
    const api = await authenticatedRequest(context);
    const res = await api.get(new URL(href!, page.url()).toString());
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/pdf');
    const body = await res.body();
    await api.dispose();

    // The PDF loads cleanly and carries the expected content.
    const doc = await PDFDocument.load(body);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    const text = await extractPdfText(new Uint8Array(body));
    expect(text).toContain('Certificate of Completion');
    expect(text).toContain(envelopeTitle);
    expect(text).toContain(recipientEmail);
  });

  test('non-completed envelope has no Certificate link', async ({ page }) => {
    await ensureLoggedInAsAdmin(page);

    const recipientEmail = `certpending-${Date.now()}@example.com`;
    const envelopeTitle = `E2E Pending Cert ${Date.now()}`;
    await buildAndSend(page, envelopeTitle, recipientEmail);

    // Sealed-artifact links (Download + Certificate) are absent; the
    // placeholder is the Audit JSON link. The "Audit certificate" tab link
    // does not match the exact name.
    await expect(page.getByRole('link', { name: 'Certificate', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /audit json/i })).toBeVisible();
  });
});
