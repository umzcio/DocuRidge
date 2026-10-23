import { test, expect, request } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { BrowserContext } from '@playwright/test';
import {
  resolveBootstrapToken,
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

/**
 * Authenticated APIRequestContext for the CSV export route. page.request /
 * storageState jars drop the host-only session cookie on the 127.0.0.1 IP
 * literal (Playwright jar quirk), so the header is sent explicitly.
 */
async function authenticatedRequest(context: BrowserContext) {
  const cookies = await context.cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return request.newContext({
    extraHTTPHeaders: cookieHeader ? { cookie: cookieHeader } : {},
  });
}

async function sendEnvelope(page: import('@playwright/test').Page, title: string, recipientEmail: string) {
  const pdfBytes = await makePdfBytes();
  await builderUploadAndContinue(page, {
    title,
    files: [{ name: 'pipeline.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfBytes) }],
  });
  await builderAddRecipient(page, 'Pipeline Recipient', recipientEmail);
  await builderPlaceSignature(page);
  await builderSend(page);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

/** Footer reads "N documents · page X of Y" — null when a single page. */
async function currentPageInfo(page: import('@playwright/test').Page) {
  const text = await page.getByText(/documents · page/i).first().innerText().catch(() => null);
  const m = text?.match(/page (\d+) of (\d+)/);
  if (!m?.[1] || !m[2]) return null;
  return { cur: parseInt(m[1], 10), last: parseInt(m[2], 10) };
}

/** Advance one page by URL (clicking the footer link races the re-render). */
async function gotoNextPage(page: import('@playwright/test').Page): Promise<boolean> {
  const info = await currentPageInfo(page);
  if (!info || info.cur >= info.last) return false;
  const u = new URL(page.url());
  u.searchParams.set('page', String(info.cur + 1));
  await page.goto(u.pathname + u.search);
  return true;
}

/**
 * The pipeline table is ordered oldest-first and paginates at 50 rows; on the
 * shared e2e stack our just-sent envelopes land on the last page. Page
 * through until the row for `title` shows up and return it.
 */
async function findRowAcrossPages(page: import('@playwright/test').Page, title: string) {
  for (let i = 0; i < 15; i++) {
    const row = page.locator('tr', { hasText: title }).first();
    if (await row.count()) return row;
    if (!(await gotoNextPage(page))) break;
  }
  throw new Error(`pipeline row for "${title}" not found after paging`);
}

test.skip(({ isMobile }) => isMobile, 'Admin/builder workflow — desktop viewport; mobile signing is covered by envelope/phase3/a11y suites');

test.describe.serial('pipeline reporting', () => {
  test('two sent envelopes appear with badges and aging; status filter, CSV export, and sender search all work', async ({
    page,
    context,
  }) => {
    await ensureLoggedInAsAdmin(page);

    const stamp = Date.now();
    const titleA = `E2E Pipeline A ${stamp}`;
    const titleB = `E2E Pipeline B ${stamp}`;
    await sendEnvelope(page, titleA, `pipe-a-${stamp}@example.com`);
    await sendEnvelope(page, titleB, `pipe-b-${stamp}@example.com`);

    // Open the pipeline via the sidebar link.
    await page.getByRole('link', { name: 'Pipeline' }).first().click();
    await expect(page).toHaveURL(/\/dashboard\/pipeline/);
    await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();

    // Both rows appear with a status badge and a days-pending value. The stack
    // is shared, so scope every assertion to our own titles and page through
    // the oldest-first table until they show up. Status is SENT or
    // IN_PROGRESS depending on invite-dispatch timing (lifecycle moves to
    // IN_PROGRESS as soon as the first invite is dispatched).
    const rowA = await findRowAcrossPages(page, titleA);
    await expect(rowA.getByText(/^(SENT|IN PROGRESS)$/)).toBeVisible();
    await expect(rowA.getByText(/^0$/)).toBeVisible();
    const rowB = await findRowAcrossPages(page, titleB);
    await expect(rowB.getByText(/^(SENT|IN PROGRESS)$/)).toBeVisible();
    await expect(rowB.getByText(/^0$/)).toBeVisible();

    // Status filter: COMPLETED drops our in-flight rows from every page.
    await page.getByRole('combobox', { name: 'Filter by status' }).click();
    await page.getByRole('option', { name: 'completed' }).click();
    for (let i = 0; i < 15; i++) {
      await expect(page.locator('tr', { hasText: titleA })).toHaveCount(0);
      await expect(page.locator('tr', { hasText: titleB })).toHaveCount(0);
      if (!(await gotoNextPage(page))) break;
    }

    // Back to the in-progress scope — rows return (again past the first
    // page on the shared stack).
    await page.getByRole('combobox', { name: 'Filter by status' }).click();
    await page.getByRole('option', { name: 'In progress (default)' }).click();
    await expect(await findRowAcrossPages(page, titleA)).toBeVisible();
    await expect(await findRowAcrossPages(page, titleB)).toBeVisible();

    // CSV export over an authenticated request context: media type, header
    // row, and both of our titles present.
    const api = await authenticatedRequest(context);
    const exportUrl = new URL('/DocuRidge/dashboard/pipeline/export', page.url()).toString();
    const res = await api.get(exportUrl);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/csv');
    const csv = await res.text();
    await api.dispose();
    const header = csv.split(/\r?\n/, 1)[0];
    expect(header).toBe(
      'Title,Status,Sender,Sender email,Current signers,Signer emails,Days pending,Sent,Last update',
    );
    expect(csv).toContain(titleA);
    expect(csv).toContain(titleB);

    // Sender search narrows results: a non-matching term drops our rows
    // everywhere, the admin's own email brings them back. (Both envelopes
    // share the one e2e sender, so the narrowing is to zero and back.)
    const senderInput = page.getByLabel('Filter by sender');
    await senderInput.fill(`no-such-sender-${stamp}`);
    await page.getByRole('button', { name: /^apply$/i }).click();
    await expect(page.locator('tr', { hasText: titleA })).toHaveCount(0);
    await expect(page.locator('tr', { hasText: titleB })).toHaveCount(0);

    await senderInput.fill(ADMIN_EMAIL);
    await page.getByRole('button', { name: /^apply$/i }).click();
    await expect(await findRowAcrossPages(page, titleA)).toBeVisible();
    await expect(await findRowAcrossPages(page, titleB)).toBeVisible();
  });
});
