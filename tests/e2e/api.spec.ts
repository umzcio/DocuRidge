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

// Path helper: with playwright.config baseURL of `…/DocuRidge/`, paths must be
// RELATIVE (no leading slash) for the basePath to be preserved.
const p = (path: string) => path.replace(/^\//, '');

// Absolute URL for the REST API (page.request does not apply baseURL here).
const API = (path: string) => {
  const base = (process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3738/DocuRidge/').replace(/\/$/, '');
  return `${base}/api/v1${path}`;
};

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'CorrectHorseBatteryStaple-2026';

const appAlert = (page: Page) =>
  page.getByRole('alert')
    .and(page.locator(':not(#__next-route-announcer__)'))
    // Sonner error toasts carry data-type instead of role="alert".
    .or(page.locator('[data-sonner-toast][data-type="error"]'));

async function makePdfBytes(text = 'API test PDF'): Promise<Uint8Array> {
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

/** Create a token through the settings UI and capture the one-time plaintext. */
async function createTokenViaUi(page: Page, name: string, opts: { write: boolean }): Promise<string> {
  await page.goto(p('/dashboard/admin?tab=api-tokens'));
  await page.getByRole('button', { name: /create token/i }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByLabel('Name', { exact: true }).fill(name);

  const readBox = dialog.getByLabel('read', { exact: true });
  const writeBox = dialog.getByLabel('write', { exact: true });
  if (!(await readBox.isChecked())) await readBox.check();
  if (opts.write) {
    if (!(await writeBox.isChecked())) await writeBox.check();
  } else if (await writeBox.isChecked()) {
    await writeBox.uncheck();
  }

  await dialog.getByRole('button', { name: /^create token$/i }).click();
  const reveal = page.getByTestId('api-token-reveal');
  await reveal.waitFor({ state: 'visible', timeout: 15000 });
  const plaintext = (await reveal.innerText()).trim();
  expect(plaintext).toMatch(/^dr_[A-Za-z0-9_-]{32}$/);
  await page.getByRole('button', { name: /i copied it/i }).click();
  return plaintext;
}

// Shared across the serial suite.
const state: {
  ts: number;
  templateId: string;
  readToken: string;
  writeToken: string;
  envelopeId: string;
  recipientEmail: string;
  otherToken: string;
} = { ts: 0, templateId: '', readToken: '', writeToken: '', envelopeId: '', recipientEmail: '', otherToken: '' };

// Admin/builder workflows — exercised at desktop viewport; mobile signing
// coverage lives in envelope/phase3/a11y suites.
test.skip(({ isMobile }) => isMobile, 'API management is a desktop workflow');

test.describe.serial('api v1 — bearer tokens, org scoping, template send', () => {
  test('setup: login, save a template, create read + write tokens via the settings UI', async ({ page }) => {
    await ensureLoggedInAsAdmin(page);
    state.ts = Date.now();
    const managerEmail = `api-tpl-${state.ts}@example.com`;

    // Build + send a source envelope, then save it as a template.
    await builderUploadAndContinue(page, {
      title: `API Tpl Source ${state.ts}`,
      files: [{ name: 'api-tpl.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await makePdfBytes('API template source')) }],
    });
    await builderAddRecipient(page, 'Manager', managerEmail);
    await builderPlaceSignature(page);
    await builderSend(page);

    await page.getByRole('button', { name: /save as template/i }).click();
    await page.getByRole('textbox', { name: /template title/i }).fill(`API Tpl ${state.ts}`);
    await page.getByRole('button', { name: /^save template$/i }).click();
    await expect(page).toHaveURL(/\/dashboard\/templates\/[a-z0-9]+$/);
    state.templateId = page.url().match(/\/dashboard\/templates\/([a-z0-9]+)$/)![1]!;

    state.readToken = await createTokenViaUi(page, `e2e-read-${state.ts}`, { write: false });
    state.writeToken = await createTokenViaUi(page, `e2e-write-${state.ts}`, { write: true });
  });

  test('401 without a token; list works with a read token', async ({ page }) => {
    const unauth = await page.request.get(API('/envelopes'));
    expect(unauth.status()).toBe(401);

    const res = await page.request.get(API('/envelopes'), {
      headers: { authorization: `Bearer ${state.readToken}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.envelopes)).toBe(true);
    expect(body).toHaveProperty('nextCursor');
    expect(body.envelopes.length).toBeGreaterThan(0);
  });

  test('POST requires the write scope', async ({ page }) => {
    const res = await page.request.post(API('/envelopes'), {
      headers: { authorization: `Bearer ${state.readToken}` },
      data: {
        templateId: state.templateId,
        recipients: [{ name: 'Nope', email: `nope-${state.ts}@example.com` }],
      },
    });
    expect(res.status()).toBe(403);
  });

  test('template-send round-trip: create, fetch documents, sign, complete', async ({ page, browser }) => {
    state.recipientEmail = `api-live-${state.ts}@example.com`;
    const title = `API Sent ${state.ts}`;

    const created = await page.request.post(API('/envelopes'), {
      headers: { authorization: `Bearer ${state.writeToken}` },
      data: {
        templateId: state.templateId,
        title,
        recipients: [{ name: 'Live Manager', email: state.recipientEmail }],
      },
    });
    expect(created.status()).toBe(201);
    const createdBody = await created.json();
    state.envelopeId = createdBody.envelopeId;
    expect(state.envelopeId).toMatch(/^[a-z0-9]+$/);
    expect(createdBody.status).toBe('IN_PROGRESS');

    // Detail reflects the title override and the recipient.
    const detail = await page.request.get(API(`/envelopes/${state.envelopeId}`), {
      headers: { authorization: `Bearer ${state.readToken}` },
    });
    expect(detail.status()).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.envelope.title).toBe(title);
    expect(detailBody.envelope.recipients[0].email).toBe(state.recipientEmail);

    // Document list + raw bytes with the stored content type.
    const docs = await page.request.get(API(`/envelopes/${state.envelopeId}/documents`), {
      headers: { authorization: `Bearer ${state.readToken}` },
    });
    expect(docs.status()).toBe(200);
    const docsBody = await docs.json();
    expect(docsBody.documents.length).toBe(1);
    const docId = docsBody.documents[0].id;

    const file = await page.request.get(API(`/envelopes/${state.envelopeId}/documents/${docId}`), {
      headers: { authorization: `Bearer ${state.readToken}` },
    });
    expect(file.status()).toBe(200);
    expect(file.headers()['content-type']).toBe('application/pdf');
    expect(file.headers()['content-disposition']).toMatch(/attachment/);

    // The invite lands and the recipient can complete the envelope.
    const link = await waitForMailLink(state.recipientEmail, /\/sign\//);
    expect(link).not.toBeNull();
    const ctx = await browser.newContext();
    const rp = await ctx.newPage();
    await rp.goto(toTestUrl(link!));
    await recipientTypedSign(rp, 'Live Manager');
    await ctx.close();

    const after = await page.request.get(API(`/envelopes/${state.envelopeId}`), {
      headers: { authorization: `Bearer ${state.readToken}` },
    });
    expect((await after.json()).envelope.status).toBe('COMPLETED');
  });

  test('cross-org token gets 404 on another org\'s envelope', async ({ page, browser }) => {
    // Register a second org + admin, verify the email, sign in, mint a token.
    const email = `api-other-${state.ts}@example.com`;
    const password = 'CorrectHorseBattery-Staple9';
    const ctx = await browser.newContext();
    const op = await ctx.newPage();

    await op.goto(p('/register'));
    await op.getByLabel('Full name').fill('Other Org Admin');
    await op.getByLabel('Email').fill(email);
    await op.getByLabel('Password').fill(password);
    await op.getByLabel('Organisation name').fill(`OtherCo ${state.ts}`);
    await op.getByRole('button', { name: /create account/i }).click();
    await expect(appAlert(op)).toContainText(/check your email/i);

    const link = await waitForMailLink(email, /\/verify\?token=/);
    expect(link).not.toBeNull();
    await op.goto(toTestUrl(link!));
    await op.getByLabel('Password').fill(password);
    await op.getByRole('button', { name: /verify email/i }).click();
    await expect(op).toHaveURL(/\/login\?verified=1/);

    await op.getByLabel('Email').fill(email);
    await op.getByLabel('Password').fill(password);
    await op.getByRole('button', { name: /^sign in$/i }).click();
    await expect(op).toHaveURL(/\/dashboard/);

    state.otherToken = await createTokenViaUi(op, `e2e-other-${state.ts}`, { write: false });
    await ctx.close();

    // Detail of the admin org's envelope: indistinguishable from missing → 404.
    const detail = await page.request.get(API(`/envelopes/${state.envelopeId}`), {
      headers: { authorization: `Bearer ${state.otherToken}` },
    });
    expect(detail.status()).toBe(404);

    // The other org's list neither errors nor leaks the foreign envelope.
    const list = await page.request.get(API('/envelopes'), {
      headers: { authorization: `Bearer ${state.otherToken}` },
    });
    expect(list.status()).toBe(200);
    const ids = (await list.json()).envelopes.map((e: { id: string }) => e.id);
    expect(ids).not.toContain(state.envelopeId);
  });

  test('revoked token is rejected with 401', async ({ page }) => {
    // The cross-org test above leaves `page` signed in as the other org's
    // admin — re-authenticate before looking for our org's token rows.
    await ensureLoggedInAsAdmin(page);
    await page.goto(p('/dashboard/admin?tab=api-tokens'));
    const row = page.locator('li', { hasText: `e2e-read-${state.ts}` });
    await row.getByRole('button', { name: /revoke/i }).click();
    // The click resolves when it dispatches — wait for the server action to
    // land (the row renders a "revoked" badge) before asserting the API sees it.
    await expect(row.getByText('revoked')).toBeVisible();

    const res = await page.request.get(API('/envelopes'), {
      headers: { authorization: `Bearer ${state.readToken}` },
    });
    expect(res.status()).toBe(401);
  });
});
