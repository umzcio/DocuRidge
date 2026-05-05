import { test, expect } from '@playwright/test';
import { resolveBootstrapToken, fetchMailhog, extractLink, toTestUrl } from './helpers';

// Path helper: with playwright.config baseURL of `…/DocuRidge/`, paths must be
// RELATIVE (no leading slash) for the basePath to be preserved.
const p = (path: string) => path.replace(/^\//, '');

// Next.js inserts an empty <div role="alert"> route announcer into every page.
// Use this filter to scope `getByRole('alert')` to our application alerts.
const appAlert = (page: import('@playwright/test').Page) =>
  page.getByRole('alert').and(page.locator(':not(#__next-route-announcer__)'));

test.describe.serial('auth — bootstrap, register, verify, login, lockout, reset', () => {
  test('bootstrap admin can complete /setup and sign in', async ({ page }) => {
    const token = await resolveBootstrapToken();
    const res = await page.goto(p('/setup'));
    if (res && res.status() === 404) test.skip(true, 'bootstrap already completed');
    if (await page.getByText(/page not found/i).isVisible().catch(() => false)) {
      test.skip(true, 'bootstrap already completed');
    }

    await page.getByLabel('Bootstrap token').fill(token);
    await page.getByLabel('Administrator password').fill('CorrectHorseBatteryStaple-2026');
    await page.getByRole('button', { name: /complete setup/i }).click();
    await expect(appAlert(page)).toContainText(/setup complete/i);

    await page.getByRole('link', { name: /sign in/i }).click();
    await page.getByLabel('Email').fill('admin@example.com');
    await page.getByLabel('Password').fill('CorrectHorseBatteryStaple-2026');
    await page.getByRole('button', { name: /^sign in$/i }).click();

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: /welcome/i })).toBeVisible();
  });

  test('register → verification email → verified login', async ({ page }) => {
    const email = `tester-${Date.now()}@example.com`;
    await page.goto(p('/register'));
    await page.getByLabel('Full name').fill('Test User');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('CorrectHorseBattery-Staple9');
    await page.getByLabel('Organisation name').fill('Test Co');
    await page.getByRole('button', { name: /create account/i }).click();
    await expect(appAlert(page)).toContainText(/check your email/i);

    const messages = await fetchMailhog().catch(() => null);
    if (!messages) test.skip(true, 'MailHog unreachable from test runner');
    const link = extractLink(messages!, email, /\/verify\?token=/);
    if (!link) test.skip(true, 'Verification link not found in MailHog');

    await page.goto(toTestUrl(link!));
    await expect(page).toHaveURL(/\/login\?verified=1/);

    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('CorrectHorseBattery-Staple9');
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('login fails with bad password and shows generic error (no email-existence oracle)', async ({ page }) => {
    await page.goto(p('/login'));
    await page.getByLabel('Email').fill('definitely-not-a-user@example.com');
    await page.getByLabel('Password').fill('whatever-is-fine-but-wrong');
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(appAlert(page)).toContainText(/incorrect/i);
  });

  test('lockout triggers after N failed attempts', async ({ page }) => {
    const email = `lockout-${Date.now()}@example.com`;
    await page.goto(p('/register'));
    await page.getByLabel('Full name').fill('Lock Out');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('CorrectHorseBattery-Staple9');
    await page.getByLabel('Organisation name').fill('LockCo');
    await page.getByRole('button', { name: /create account/i }).click();
    await expect(appAlert(page)).toContainText(/check your email/i);

    // Fire 6 failed attempts (default LOCKOUT_MAX_ATTEMPTS=5).
    for (let i = 0; i < 6; i++) {
      await page.goto(p('/login'));
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill('this-is-wrong');
      await page.getByRole('button', { name: /^sign in$/i }).click();
      await page.waitForLoadState('networkidle');
    }
    await expect(appAlert(page)).toContainText(/locked|too many/i);
  });

  test('password reset round-trip', async ({ page }) => {
    const email = `reset-${Date.now()}@example.com`;
    await page.goto(p('/register'));
    await page.getByLabel('Full name').fill('Reset User');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('Original-Phrase-Nine');
    await page.getByLabel('Organisation name').fill('Reset Co');
    await page.getByRole('button', { name: /create account/i }).click();
    await expect(appAlert(page)).toContainText(/check your email/i);

    await page.goto(p('/reset'));
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: /send reset link/i }).click();
    await expect(appAlert(page)).toContainText(/if that email is registered/i);

    const messages = await fetchMailhog().catch(() => null);
    if (!messages) test.skip(true, 'MailHog unreachable');
    const link = extractLink(messages!, email, /\/reset\//);
    if (!link) test.skip(true, 'Reset link not found in MailHog');

    await page.goto(toTestUrl(link!));
    await page.getByLabel('New password').fill('Brand-New-Phrase-Six');
    await page.getByRole('button', { name: /set new password/i }).click();
    await expect(appAlert(page)).toContainText(/password updated/i);
  });
});

test.describe('health endpoints', () => {
  test('/healthz returns 200', async ({ request }) => {
    const res = await request.get('healthz');
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });
  test('/readyz returns 200 with database ok', async ({ request }) => {
    const res = await request.get('readyz');
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ready', database: 'ok' });
  });
});
