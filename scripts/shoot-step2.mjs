import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const browser = await chromium.launch();
const ctxDesktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxMobile = await browser.newContext({ viewport: { width: 390, height: 844 } });

const base = 'http://127.0.0.1:3737/DocuRidge';
const ADMIN = 'admin@example.com';
const PASS = 'CorrectHorseBatteryStaple-2026';

async function makePdf(text) {
  const d = await PDFDocument.create();
  const p = d.addPage([612, 300]);
  const f = await d.embedFont(StandardFonts.Helvetica);
  p.drawText(text, { x: 50, y: 250, size: 16, font: f });
  return Buffer.from(await d.save());
}

async function login(ctx) {
  const page = await ctx.newPage();
  const setupRes = await page.request.get(`${base}/setup`);
  if (setupRes.status() !== 404) {
    const env = readFileSync('/projects/DocuRidge/.env', 'utf8');
    const m = env.match(/^BOOTSTRAP_TOKEN=(.*)$/m);
    const token = m ? m[1].trim() : '';
    await page.goto(`${base}/setup`);
    await page.getByLabel('Bootstrap token').fill(token);
    await page.getByLabel('Administrator password').fill(PASS);
    await page.getByRole('button', { name: /complete setup/i }).click();
    await page.waitForLoadState('networkidle');
  }
  await page.goto(`${base}/login`);
  await page.getByLabel('Email').fill(ADMIN);
  await page.getByLabel('Password').fill(PASS);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10000 });
  await page.waitForTimeout(900);
  return page;
}

async function seedEnvelopes(page) {
  const recipients = [
    { name: 'Aria Mendez', email: 'aria@example.com', title: 'Annual sponsorship agreement' },
    { name: 'Brendan Cole', email: 'brendan@example.com', title: 'Vendor MSA — Frontier Cloud' },
    { name: 'Citlali Reyes', email: 'citlali@example.com', title: 'Independent contractor — Q3 deliverables' },
    { name: 'Dmitri Volkov', email: 'dmitri@example.com', title: 'Research data sharing addendum' },
  ];
  for (const r of recipients) {
    await page.goto(`${base}/dashboard/envelopes/new`);
    await page.getByLabel('Title').fill(r.title);
    await page.getByRole('textbox', { name: 'Name' }).first().fill(r.name);
    await page.getByRole('textbox', { name: 'Email' }).first().fill(r.email);
    await page.locator('input[type=file][accept="application/pdf"]').setInputFiles({
      name: 'doc.pdf', mimeType: 'application/pdf', buffer: await makePdf(r.title),
    });
    await page.waitForTimeout(400);
    await page.locator('button[aria-label="Place a Signature field"]').click();
    const wrap = page.locator('[data-page-target][data-armed-type="SIGNATURE"]').first();
    await wrap.waitFor({ state: 'visible', timeout: 10000 });
    await wrap.click({ position: { x: 80, y: 60 }, force: true });
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /create & send envelope/i }).click();
    await page.waitForURL(/\/dashboard\/envelopes\/c[a-z0-9]{20,}$/, { timeout: 10000 });
  }
  // Mark one as completed by signing it
  // Skip — complexity not worth for a screenshot demo. Status will be IN_PROGRESS / SENT.
}

const desktop = await login(ctxDesktop);
await seedEnvelopes(desktop);
await desktop.goto(`${base}/dashboard`);
await desktop.waitForTimeout(900);
await desktop.screenshot({ path: '/tmp/docuridge_screenshots/phase5/step2/dashboard_desktop_v1.png', fullPage: true });

const mobile = await login(ctxMobile);
await mobile.goto(`${base}/dashboard`);
await mobile.waitForTimeout(900);
await mobile.screenshot({ path: '/tmp/docuridge_screenshots/phase5/step2/dashboard_mobile_v1.png', fullPage: true });

await browser.close();
console.log('done');
