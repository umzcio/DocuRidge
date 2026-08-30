import { test, expect, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  resolveBootstrapToken,
  waitForMailLink,
  toTestUrl,
  fetchMailhog,
  builderUploadAndContinue,
  builderAddRecipient,
  builderPlaceSignature,
  builderSend,
} from './helpers';

const p = (path: string) => path.replace(/^\//, '');

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'CorrectHorseBatteryStaple-2026';

const appAlert = (page: Page) =>
  page.getByRole('alert').and(page.locator(':not(#__next-route-announcer__)'));

async function makePdfBytes(text = 'Reminder test'): Promise<Uint8Array> {
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

/** Decode a quoted-printable string: soft line breaks and =XX hex escapes. */
function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Poll MailHog for the reminder email specifically (subject prefixed
 * "Reminder:" — see envelopeReminderTemplate), as distinct from the
 * original invite sent to the same address. Returns its /sign/ link.
 */
async function waitForReminderMailLink(toEmail: string, timeoutMs = 8000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const messages = await fetchMailhog();
      for (const item of messages.items) {
        const recipients = item.To.map((t) => `${t.Mailbox}@${t.Domain}`.toLowerCase());
        if (!recipients.includes(toEmail.toLowerCase())) continue;
        const subject = (item.Content.Headers.Subject?.[0] ?? '');
        if (!subject.toLowerCase().startsWith('reminder')) continue;
        const decoded = decodeQuotedPrintable(item.Content.Body);
        const matches = decoded.match(/https?:\/\/[^\s<>"]+/g) ?? [];
        for (const candidate of matches) {
          try {
            const u = new URL(candidate);
            if (/\/sign\//.test(u.pathname)) return candidate;
          } catch {
            // not a URL
          }
        }
      }
    } catch {
      // mailhog may briefly be unavailable; retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

test.describe.serial('reminder — resending an invite to a recipient who already opened their link', () => {
  test('reminder link works after being opened; the superseded original link no longer does', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);

    const ts = Date.now();
    const signerEmail = `reminder-signer-${ts}@example.com`;

    // 1. Build and send a one-signer envelope.
    await builderUploadAndContinue(page, {
      title: `Reminder Test ${ts}`,
      files: [{ name: 'reminder.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await makePdfBytes()) }],
    });
    await builderAddRecipient(page, 'Reminder Signer', signerEmail);
    await builderPlaceSignature(page);
    await builderSend(page);
    await expect(page).toHaveURL(/\/dashboard\/envelopes\/[a-z0-9]+$/);

    // 2. Fetch the original invite link.
    const originalLink = await waitForMailLink(signerEmail, /\/sign\//);
    expect(originalLink).not.toBeNull();

    // 3. Recipient OPENS their link (does not sign). This is the precondition
    // for bug 3: recordRecipientOpened pins tokenJti to the original jti as
    // soon as the ceremony page loads, regardless of this plan's fix.
    const openCtx = await browser.newContext();
    const openPage = await openCtx.newPage();
    await openPage.goto(toTestUrl(originalLink!));
    await expect(
      openPage.getByLabel(/i agree to use electronic records/i),
    ).toBeVisible({ timeout: 10000 });
    await openCtx.close();

    // 4. Sender triggers a reminder from the envelope detail page (we're
    // still on it, from the builderSend assertion above).
    await page.getByRole('button', { name: /send reminder/i }).click();
    await expect(page.getByRole('status')).toContainText(/reminder sent/i, { timeout: 10000 });

    // 5. Fetch the reminder's freshly minted link, and confirm it differs
    // from the original (a new token was minted, as the source comments
    // describe).
    const reminderLink = await waitForReminderMailLink(signerEmail);
    expect(reminderLink).not.toBeNull();
    expect(reminderLink).not.toBe(originalLink);

    // 6. THE REGRESSION GUARD (bug 3): the reminder link must actually work
    // for exactly the population a reminder targets — someone who already
    // opened their original link. Before plan 018's fix, sendReminderToNextSigner
    // minted a fresh jti but never pinned it, so the guard's single-use check
    // (recipient.tokenJti [the original, pinned on open] !== claims.jti [the
    // reminder's new jti]) rejected the reminder link as "consumed".
    const reminderCtx = await browser.newContext();
    const reminderPage = await reminderCtx.newPage();
    await reminderPage.goto(toTestUrl(reminderLink!));
    await expect(
      reminderPage.getByLabel(/i agree to use electronic records/i),
    ).toBeVisible({ timeout: 10000 });
    await reminderCtx.close();

    // 7. Negative test: the superseded original link must now be dead.
    const staleCtx = await browser.newContext();
    const stalePage = await staleCtx.newPage();
    await stalePage.goto(toTestUrl(originalLink!));
    await expect(
      stalePage.getByRole('heading', { name: /already signed|signing unavailable/i }),
    ).toBeVisible({ timeout: 10000 });
    await staleCtx.close();
  });
});
