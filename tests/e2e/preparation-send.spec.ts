import { test, expect, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import { builderUploadAndContinue, builderAddRecipient, builderPlaceSignature, builderSend, waitForMailLink, toTestUrl, recipientTypedSign } from './helpers';

// These tests use the real Next server action, database, invitations and sealing.
// Only the model's nondeterministic analysis is replaced with a known response.
test.beforeEach(async ({ page }) => {
  await page.goto('login');
  await page.getByLabel('Email', { exact: true }).fill('admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill('CorrectHorseBatteryStaple-2026');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});
async function upload(page: Page, title: string, fixture?: string) {
  const pdf = await PDFDocument.create(); pdf.addPage([612, 300]);
  await builderUploadAndContinue(page, { title, files: [{ name: 'review.pdf', mimeType: 'application/pdf', buffer: fixture ? readFileSync(fixture) : Buffer.from(await pdf.save()) }] });
}

test('AI signature defaults can actually send, receive an invite, sign and seal an edited PDF', async ({ page, browser }) => {
  const email = `ai-send-${Date.now()}@example.com`;
  await page.route('**/api/ai/field-suggestions', route => route.fulfill({ json: route.request().method() === 'GET' ? { enabled: true } : { suggestions: process.env.PREPARATION_SUGGESTIONS ? JSON.parse(readFileSync(process.env.PREPARATION_SUGGESTIONS, 'utf8')).raw : [
    { type: 'SIGNATURE', page: 1, x: 0.15, y: 0.3, w: 0.3, h: 0.06, label: 'Signature', confidence: 0.98 },
    { type: 'CHECKBOX', page: 1, x: 0.65, y: 0.3, w: 0.03, h: 0.06, label: 'Optional selection', confidence: 0.9 },
  ] } }));
  await upload(page, `AI Send ${Date.now()}`, process.env.PREPARATION_PDF);
  await page.getByRole('button', { name: 'Edit PDF', exact: true }).last().click();
  const editor = page.getByRole('dialog');
  await editor.getByRole('button', { name: 'Rotate right', exact: true }).click();
  await editor.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(editor).toBeHidden();
  await page.getByRole('button', { name: 'AI: Suggest fields', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Analyze document', exact: true }).click();
  await expect(dialog.getByText(/\d+ selected · \d+ suggestions/)).toBeVisible();
  await dialog.getByLabel('Signer name', { exact: true }).fill('AI Test Signer');
  await dialog.getByLabel('Signer email', { exact: true }).fill(email);
  await dialog.getByRole('button', { name: 'Add signer', exact: true }).click();
  await dialog.getByRole('button', { name: /^Add \d+ selected fields$/ }).click();
  await builderSend(page);
  const link = await waitForMailLink(email, /\/sign\//);
  expect(link).not.toBeNull();
  const context = await browser.newContext();
  try {
    const signer = await context.newPage();
    await signer.goto(toTestUrl(link!));
    await recipientTypedSign(signer, 'AI Test Signer');
  } finally { await context.close(); }
  await page.reload();
  const download = page.getByRole('link', { name: /download/i }).first();
  await expect(download).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await download.click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toMatch(/\.signed\.pdf$/);
  const sealed = await PDFDocument.load(readFileSync((await file.path())!));
  expect(sealed.getPage(0).getSize()).toEqual(process.env.PREPARATION_PDF ? { width: 792, height: 612 } : { width: 300, height: 612 });
});

test('PDF survives repeated server validation failures and can be sent after correction', async ({ page }) => {
  await upload(page, `Retry Send ${Date.now()}`);
  await builderAddRecipient(page, 'Retry Signer', `retry-send-${Date.now()}@example.com`);
  await builderPlaceSignature(page);
  const region = page.getByRole('region', { name: 'Document preparation' });
  await region.getByLabel('Document name', { exact: true }).fill('');
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/envelopes/new'));
    await page.getByRole('button', { name: /^send for signature/i }).click();
    await response;
    await expect(page.getByRole('button', { name: /^send for signature/i })).toBeEnabled();
    await expect(region.getByRole('alert')).toHaveText('Title is required');
  }
  await region.getByLabel('Document name', { exact: true }).fill(`Corrected ${Date.now()}`);
  await builderSend(page);
});


test('preparation is locked while the real send request is in flight', async ({ page }) => {
  await upload(page, `Pending Send ${Date.now()}`);
  await builderAddRecipient(page, 'Pending Signer', `pending-${Date.now()}@example.com`);
  await builderPlaceSignature(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/dashboard/envelopes/new', async route => {
    if (route.request().method() === 'POST') await gate;
    await route.continue();
  });
  await page.getByRole('button', { name: /^send for signature/i }).click();
  try {
    await expect(page.getByRole('status')).toContainText('Submitting your envelope');
    const region = page.locator('[aria-label="Document preparation"]');
    await expect(region.locator('input[aria-label="Document name"]')).toBeDisabled();
    await expect(region.getByRole('button', { name: /Exit/, includeHidden: true })).toBeDisabled();
  } finally { release(); }
  await expect(page).toHaveURL(/\/dashboard\/envelopes\/(?!new$)[a-z0-9]+$/);
});


test('interrupted submission keeps prepared work and requires checking before retry', async ({ page }) => {
  await upload(page, `Interrupted Send ${Date.now()}`);
  await builderAddRecipient(page, 'Retry Signer', `interrupted-${Date.now()}@example.com`);
  await builderPlaceSignature(page);
  const before = await page.locator('input[name=fields]').inputValue();
  await page.route('**/dashboard/envelopes/new', route => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
  await page.getByRole('button', { name: /^send for signature/i }).click();
  const region = page.getByRole('region', { name: 'Document preparation' });
  await expect(region.getByRole('alert')).toContainText('server response was interrupted');
  await expect(page.getByRole('button', { name: /^send for signature/i })).toBeDisabled();
  expect(await page.locator('input[name=fields]').inputValue()).toBe(before);
  await expect(region.getByRole('link', { name: 'Open dashboard' })).toHaveAttribute('target', '_blank');
  await page.unroute('**/dashboard/envelopes/new');
  await region.getByRole('button', { name: 'I checked; allow retry' }).click();
  await builderSend(page);
});

test('failed invitation delivery is visible and retry uses the same envelope', async ({ page }) => {
  test.setTimeout(60000);
  test.skip(process.env.DOCURIDGE_APP_CONTAINER !== 'docuridge_e2e_app', 'Mail fault injection is restricted to the isolated test stack.');
  const { execFileSync } = await import('node:child_process');
  const email = `delivery-retry-${Date.now()}@example.com`;
  await upload(page, `Delivery Retry ${Date.now()}`);
  await builderAddRecipient(page, 'Delivery Signer', email);
  await builderPlaceSignature(page);
  execFileSync('docker', ['stop', 'docuridge_e2e_mailhog'], { stdio: 'ignore' });
  try {
    await builderSend(page);
    await expect(page.getByRole('alert').filter({ hasText: 'an invitation email was not delivered' })).toBeVisible();
    await expect(page.getByText('Email failed', { exact: true })).toBeVisible();
  } finally {
    execFileSync('docker', ['start', 'docuridge_e2e_mailhog'], { stdio: 'ignore' });
  }
  const existingUrl = page.url();
  await page.getByRole('button', { name: 'Send reminder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(/reminder sent/i);
  expect(await waitForMailLink(email, /\/sign\//)).not.toBeNull();
  await expect(page.getByRole('alert').filter({ hasText: 'an invitation email was not delivered' })).toHaveCount(0);
  expect(page.url()).toBe(existingUrl);
});
