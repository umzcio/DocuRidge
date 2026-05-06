import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const browser = await chromium.launch();
const ctxD = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 } });

const base = 'http://127.0.0.1:3737/DocuRidge';
const ADMIN = 'admin@example.com';
const PASS = 'CorrectHorseBatteryStaple-2026';

async function login(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${base}/login`);
  await page.getByLabel('Email').fill(ADMIN);
  await page.getByLabel('Password').fill(PASS);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10000 });
  await page.waitForTimeout(700);
  return page;
}

async function shoot(ctx, viewport, viewName, url) {
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `/tmp/docuridge_screenshots/phase5/inter/${viewName}_${viewport}.png`, fullPage: true });
  await page.close();
}

await shoot(ctxD, 'desktop', 'login', `${base}/login`);
await shoot(ctxM, 'mobile', 'login', `${base}/login`);
await shoot(ctxD, 'desktop', 'register', `${base}/register`);

const dashD = await login(ctxD);
await dashD.screenshot({ path: '/tmp/docuridge_screenshots/phase5/inter/dashboard_desktop.png', fullPage: true });

const dashM = await login(ctxM);
await dashM.screenshot({ path: '/tmp/docuridge_screenshots/phase5/inter/dashboard_mobile.png', fullPage: true });

await browser.close();
console.log('done');
