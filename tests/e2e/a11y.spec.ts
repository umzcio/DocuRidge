import { test, expect, type Page, type Browser } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveBootstrapToken,
  waitForMailLink,
  toTestUrl,
  builderUploadAndContinue,
  builderAddRecipient,
  builderPlaceSignature,
  builderSend,
} from './helpers';

const p = (path: string) => path.replace(/^\//, '');

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'CorrectHorseBatteryStaple-2026';

const SHOT_DIR = '/tmp/docuridge_screenshots/a11y';
mkdirSync(SHOT_DIR, { recursive: true });

const appAlert = (page: Page) =>
  page.getByRole('alert').and(page.locator(':not(#__next-route-announcer__)'));

async function makePdfBytes(text = 'A11y test'): Promise<Uint8Array> {
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

interface Audit {
  view: string;
  violations: Array<{
    id: string;
    impact: string | undefined;
    description: string;
    nodes: number;
    nodeSamples: string[];
  }>;
}

async function auditPage(page: Page, view: string): Promise<Audit> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = result.violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? undefined,
    description: v.description,
    nodes: v.nodes.length,
    nodeSamples: v.nodes.slice(0, 2).map((n) => n.html.slice(0, 200)),
  }));
  return { view, violations: summary };
}

async function shoot(page: Page, name: string, viewport: 'desktop' | 'mobile') {
  const path = join(SHOT_DIR, `${name}_${viewport}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

test.describe.serial('accessibility — desktop (1440x900)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const audits: Audit[] = [];

  test.afterAll(async () => {
    writeFileSync(
      join(SHOT_DIR, 'desktop-axe-summary.json'),
      JSON.stringify(audits, null, 2),
    );
    const totalViolations = audits.reduce((s, a) => s + a.violations.length, 0);
    console.log(`\nDESKTOP A11Y SUMMARY — ${totalViolations} violations across ${audits.length} views`);
    for (const a of audits) {
      console.log(`  ${a.view}: ${a.violations.length} violation${a.violations.length === 1 ? '' : 's'}`);
      for (const v of a.violations) {
        console.log(`    [${v.impact ?? 'minor'}] ${v.id} — ${v.description} (${v.nodes} node${v.nodes === 1 ? '' : 's'})`);
      }
    }
  });

  test('login page', async ({ page }) => {
    await page.goto(p('/login'));
    await shoot(page, 'login', 'desktop');
    audits.push(await auditPage(page, 'login'));
  });

  test('register page', async ({ page }) => {
    await page.goto(p('/register'));
    await shoot(page, 'register', 'desktop');
    audits.push(await auditPage(page, 'register'));
  });

  test('password-reset page', async ({ page }) => {
    await page.goto(p('/reset'));
    await shoot(page, 'reset', 'desktop');
    audits.push(await auditPage(page, 'reset'));
  });

  test('dashboard (signed in, empty + populated)', async ({ page }) => {
    await ensureLoggedInAsAdmin(page);
    await page.goto(p('/dashboard'));
    await shoot(page, 'dashboard', 'desktop');
    audits.push(await auditPage(page, 'dashboard'));
  });

  test('envelope builder (new)', async ({ page }) => {
    await ensureLoggedInAsAdmin(page);
    // Render the populated prepare overlay so we audit the active state,
    // not the bare upload form.
    await builderUploadAndContinue(page, {
      title: 'A11y Builder',
      files: [{ name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await makePdfBytes()) }],
    });
    await builderAddRecipient(page, 'Tester', 'a11y@example.com');
    await builderPlaceSignature(page);
    await shoot(page, 'envelope-builder', 'desktop');
    audits.push(await auditPage(page, 'envelope-builder'));
  });

  test('envelope detail + signing ceremony', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);
    const recipientEmail = `a11y-${Date.now()}@example.com`;
    await builderUploadAndContinue(page, {
      title: 'A11y Detail',
      files: [{ name: 'd.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await makePdfBytes()) }],
    });
    await builderAddRecipient(page, 'Tester', recipientEmail);
    await builderPlaceSignature(page);
    await builderSend(page);
    await expect(page).toHaveURL(/\/dashboard\/envelopes\/c[a-z0-9]{20,}$/);
    await shoot(page, 'envelope-detail', 'desktop');
    audits.push(await auditPage(page, 'envelope-detail'));

    // Recipient signing ceremony
    const link = await waitForMailLink(recipientEmail, /\/sign\//);
    expect(link).not.toBeNull();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const rp = await ctx.newPage();
    await rp.goto(toTestUrl(link!));
    await shoot(rp, 'signing-consent', 'desktop');
    audits.push(await auditPage(rp, 'signing-consent'));

    await rp.getByLabel(/i agree to use electronic records/i).check();
    await rp.getByRole('button', { name: /i agree, continue/i }).click();
    await shoot(rp, 'signing-ceremony', 'desktop');
    audits.push(await auditPage(rp, 'signing-ceremony'));
    await ctx.close();
  });

  test('templates list', async ({ page }) => {
    await ensureLoggedInAsAdmin(page);
    await page.goto(p('/dashboard/templates'));
    await shoot(page, 'templates-list', 'desktop');
    audits.push(await auditPage(page, 'templates-list'));
  });
});

test.describe.serial('accessibility — mobile (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  const audits: Audit[] = [];

  test.afterAll(async () => {
    writeFileSync(
      join(SHOT_DIR, 'mobile-axe-summary.json'),
      JSON.stringify(audits, null, 2),
    );
    const totalViolations = audits.reduce((s, a) => s + a.violations.length, 0);
    console.log(`\nMOBILE A11Y SUMMARY — ${totalViolations} violations across ${audits.length} views`);
    for (const a of audits) {
      console.log(`  ${a.view}: ${a.violations.length} violation${a.violations.length === 1 ? '' : 's'}`);
      for (const v of a.violations) {
        console.log(`    [${v.impact ?? 'minor'}] ${v.id} — ${v.description} (${v.nodes} node${v.nodes === 1 ? '' : 's'})`);
      }
    }
  });

  test('login page', async ({ page }) => {
    await page.goto(p('/login'));
    await shoot(page, 'login', 'mobile');
    audits.push(await auditPage(page, 'login'));
  });

  test('register page', async ({ page }) => {
    await page.goto(p('/register'));
    await shoot(page, 'register', 'mobile');
    audits.push(await auditPage(page, 'register'));
  });

  test('dashboard', async ({ page }) => {
    await ensureLoggedInAsAdmin(page);
    await page.goto(p('/dashboard'));
    await shoot(page, 'dashboard', 'mobile');
    audits.push(await auditPage(page, 'dashboard'));
  });

  test('signing ceremony — mobile recipient experience', async ({ page, browser }) => {
    // Sender prep on desktop
    const ctxAdmin = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const adminPage = await ctxAdmin.newPage();
    await ensureLoggedInAsAdmin(adminPage);
    const recipientEmail = `a11y-mobile-${Date.now()}@example.com`;
    await builderUploadAndContinue(adminPage, {
      title: 'Mobile A11y',
      files: [{ name: 'm.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await makePdfBytes()) }],
    });
    await builderAddRecipient(adminPage, 'Mobile Tester', recipientEmail);
    await builderPlaceSignature(adminPage);
    await builderSend(adminPage);
    await ctxAdmin.close();

    const link = await waitForMailLink(recipientEmail, /\/sign\//);
    expect(link).not.toBeNull();

    await page.goto(toTestUrl(link!));
    await shoot(page, 'signing-consent', 'mobile');
    audits.push(await auditPage(page, 'signing-consent'));

    await page.getByLabel(/i agree to use electronic records/i).check();
    await page.getByRole('button', { name: /i agree, continue/i }).click();
    await shoot(page, 'signing-ceremony', 'mobile');
    audits.push(await auditPage(page, 'signing-ceremony'));
  });
});
