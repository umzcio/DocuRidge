import { execSync } from 'node:child_process';
import type { Page, Browser } from '@playwright/test';
import { expect } from '@playwright/test';

const _p = (path: string) => path.replace(/^\//, '');

/**
 * Drive the new two-phase builder to upload PDFs, set the title, and continue
 * to the fullscreen prepare overlay. Replaces the older flat single-page form.
 */
export async function builderUploadAndContinue(page: Page, opts: {
  title: string;
  files: Array<{ name: string; mimeType: string; buffer: Buffer }>;
}): Promise<void> {
  await page.goto(_p('/dashboard/envelopes/new'));
  await page.locator('input[type=file][accept="application/pdf"]').setInputFiles(opts.files);
  // Filenames render as <p>{name}</p>; wait for the first one to land.
  for (const f of opts.files) {
    await page.getByText(f.name, { exact: false }).first().waitFor({ state: 'visible', timeout: 10000 });
  }
  // The Document name input only appears once a doc is uploaded.
  const titleInput = page.getByLabel('Document name');
  await titleInput.waitFor({ state: 'visible' });
  await titleInput.fill(opts.title);
  await page.getByRole('button', { name: /continue to prepare/i }).click();
  // Confirm the overlay rendered by waiting for the Send for signature button.
  await page.getByRole('button', { name: /send for signature/i }).waitFor({ state: 'visible', timeout: 10000 });
}

/**
 * Add a recipient through the modal triggered by the left-rail "+ Add" button.
 */
export async function builderAddRecipient(page: Page, name: string, email: string, role: 'SIGNER' | 'CC' = 'SIGNER'): Promise<void> {
  await page.locator('[data-testid="builder-add-recipient"]').click();
  const modal = page.locator('[role="dialog"]');
  await modal.waitFor({ state: 'visible' });
  await modal.getByLabel('Name', { exact: true }).fill(name);
  await modal.getByLabel('Email', { exact: true }).fill(email);
  if (role === 'CC') {
    await modal.locator('select').selectOption('CC');
  }
  await modal.getByRole('button', { name: /^add recipient$/i }).click();
  await modal.waitFor({ state: 'hidden', timeout: 5000 });
}

/**
 * Arm the Signature tile and click on a page wrap to drop one. Defaults to the
 * top-left corner so the marker stays inside short test PDFs.
 */
export async function builderPlaceSignature(page: Page, pageIndex = 0, position = { x: 80, y: 80 }): Promise<void> {
  // Disarm anything hot.
  await page.keyboard.press('Escape').catch(() => {});
  await page.locator('button[aria-label="Place a Signature field"]').click();
  await page.locator('[data-page-target][data-armed-type="SIGNATURE"]').first().waitFor({ state: 'visible', timeout: 10000 });
  const wrap = page.locator('[data-page-target]').nth(pageIndex);
  await wrap.scrollIntoViewIfNeeded();
  await wrap.click({ position, force: true });
}

/**
 * Submit the prepare overlay's "Send for signature" button.
 */
export async function builderSend(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^send for signature/i }).click();
  await expect(page).toHaveURL(/\/dashboard\/envelopes\/[a-z0-9]+$/, { timeout: 30000 });
}

/**
 * Drive the recipient signing ceremony: consent → click first signature
 * field → switch to Type tab → adopt → Finish & submit. Returns once the
 * success screen appears.
 */
export async function recipientTypedSign(rp: Page, name: string): Promise<void> {
  // Consent
  await rp.getByLabel(/i agree to use electronic records/i).check();
  await rp.getByRole('button', { name: /i agree, continue/i }).click();

  // Click the first required (signature) field on the right rail to open the modal.
  // The pulse-ring class identifies un-completed required fields.
  const firstReq = rp.locator('button.sig-pulse').first();
  await firstReq.waitFor({ state: 'visible', timeout: 10000 });
  await firstReq.click();

  const modal = rp.locator('[role="dialog"]');
  await modal.waitFor({ state: 'visible' });
  // Switch to Type tab and fill
  await modal.getByRole('button', { name: /^type$/i }).click();
  await modal.getByPlaceholder(/type your full name/i).fill(name);
  await modal.getByRole('button', { name: /adopt.*sign/i }).click();
  await modal.waitFor({ state: 'hidden', timeout: 5000 });

  // Finish & submit
  await rp.getByRole('button', { name: /finish.*submit/i }).click();
  await rp.getByRole('heading', { name: /document signed/i }).waitFor({ state: 'visible', timeout: 15000 });
}

/**
 * Resolve the BOOTSTRAP_TOKEN value the running app expects.
 *
 * Strategy: read it from inside the running app container's environment.
 * If we can't reach Docker (e.g., tests run outside the host), fall back
 * to the host's .env file.
 */
export async function resolveBootstrapToken(): Promise<string> {
  if (process.env.BOOTSTRAP_TOKEN) return process.env.BOOTSTRAP_TOKEN;
  try {
    const out = execSync(
      "docker exec docuridge_app sh -c 'echo $BOOTSTRAP_TOKEN'",
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (out) return out;
  } catch {
    // fallthrough
  }
  const envFile = require('node:fs').readFileSync('.env', 'utf8') as string;
  const match = envFile.match(/^BOOTSTRAP_TOKEN=(.*)$/m);
  if (match && match[1]) return match[1].trim();
  throw new Error('BOOTSTRAP_TOKEN unavailable');
}

interface MailhogMessage {
  Content: { Headers: Record<string, string[]>; Body: string };
  To: { Mailbox: string; Domain: string }[];
  From: { Mailbox: string; Domain: string };
}

interface MailhogResponse {
  total: number;
  count: number;
  start: number;
  items: MailhogMessage[];
}

export async function fetchMailhog(): Promise<MailhogResponse> {
  const url = process.env.MAILHOG_API_URL || 'http://localhost:8737/api/v2/messages';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MailHog returned ${res.status}`);
  return (await res.json()) as MailhogResponse;
}

/**
 * Poll mailhog until a message matching `toEmail` + `pathRegex` is present,
 * or until `timeoutMs` elapses. Returns the matched URL or null on timeout.
 */
export async function waitForMailLink(
  toEmail: string,
  pathRegex: RegExp,
  timeoutMs = 8000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const messages = await fetchMailhog();
      const link = extractLink(messages, toEmail, pathRegex);
      if (link) return link;
    } catch {
      // mailhog may briefly be unavailable; retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** Decode a quoted-printable string: soft line breaks (=\r?\n) and =XX hex escapes. */
function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function extractLink(
  res: MailhogResponse,
  toEmail: string,
  pathRegex: RegExp,
): string | null {
  for (const item of res.items) {
    const recipients = item.To.map((t) => `${t.Mailbox}@${t.Domain}`.toLowerCase());
    if (!recipients.includes(toEmail.toLowerCase())) continue;
    const decoded = decodeQuotedPrintable(item.Content.Body);
    // Match http(s) URLs; the test wants the one whose pathname matches.
    const urlRegex = /https?:\/\/[^\s<>"]+/g;
    const matches = decoded.match(urlRegex) ?? [];
    for (const candidate of matches) {
      try {
        const u = new URL(candidate);
        if (pathRegex.test(u.pathname + u.search)) return candidate;
      } catch {
        // not a URL
      }
    }
  }
  return null;
}

/**
 * Turn a public, absolute URL (from an email) into one against the test's
 * own origin. Preserves pathname + search. Used so tests can navigate to
 * tokens minted with PUBLIC_URL while the test stack is on 127.0.0.1.
 */
export function toTestUrl(absoluteUrl: string): string {
  const base = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3737/DocuRidge/';
  const baseOrigin = new URL(base).origin;
  const u = new URL(absoluteUrl);
  return `${baseOrigin}${u.pathname}${u.search}`;
}
