import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctxDesktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxMobile = await browser.newContext({ viewport: { width: 390, height: 844 } });

const pageDesktop = await ctxDesktop.newPage();
const pageMobile = await ctxMobile.newPage();

const base = 'http://127.0.0.1:3737/DocuRidge';
const views = [
  { name: 'login', url: `${base}/login` },
  { name: 'register', url: `${base}/register` },
  { name: 'reset', url: `${base}/reset` },
];

for (const v of views) {
  await pageDesktop.goto(v.url);
  await pageDesktop.waitForLoadState('networkidle');
  await pageDesktop.screenshot({ path: `/tmp/docuridge_screenshots/phase5/step1/${v.name}_desktop_v1.png`, fullPage: true });
  await pageMobile.goto(v.url);
  await pageMobile.waitForLoadState('networkidle');
  await pageMobile.screenshot({ path: `/tmp/docuridge_screenshots/phase5/step1/${v.name}_mobile_v1.png`, fullPage: true });
}
await browser.close();
console.log('done');
