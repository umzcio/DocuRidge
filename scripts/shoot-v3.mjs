import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctxD = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 } });
const base = 'http://127.0.0.1:3737/DocuRidge';

async function login(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${base}/login`);
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password').fill('CorrectHorseBatteryStaple-2026');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10000 });
  await page.waitForTimeout(800);
  return page;
}

const dLogin = await ctxD.newPage();
await dLogin.goto(`${base}/login`);
await dLogin.waitForLoadState('networkidle');
await dLogin.waitForTimeout(700);
await dLogin.screenshot({ path: '/tmp/docuridge_screenshots/phase5/v3/login_desktop.png', fullPage: true });

const mLogin = await ctxM.newPage();
await mLogin.goto(`${base}/login`);
await mLogin.waitForLoadState('networkidle');
await mLogin.waitForTimeout(700);
await mLogin.screenshot({ path: '/tmp/docuridge_screenshots/phase5/v3/login_mobile.png', fullPage: true });

const dDash = await login(ctxD);
await dDash.screenshot({ path: '/tmp/docuridge_screenshots/phase5/v3/dashboard_desktop.png', fullPage: true });

const mDash = await login(ctxM);
await mDash.screenshot({ path: '/tmp/docuridge_screenshots/phase5/v3/dashboard_mobile.png', fullPage: true });

await browser.close();
console.log('done');
