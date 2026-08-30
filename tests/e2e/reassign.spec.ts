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
} from './helpers';

const p = (path: string) => path.replace(/^\//, '');

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'CorrectHorseBatteryStaple-2026';

const appAlert = (page: Page) =>
  page.getByRole('alert').and(page.locator(':not(#__next-route-announcer__)'));

async function makePdfBytes(text = 'Reassign test'): Promise<Uint8Array> {
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

/**
 * Open the ceremony as the original recipient, run consent, then use the
 * "Forward to someone else" affordance to delegate to a new email + name.
 * Returns the success message shown on the "Forwarded successfully" screen,
 * which — per the regression this spec guards — must name the new
 * recipient rather than an allowlist-refusal error.
 */
async function reassignAtLink(
  browser: Browser,
  link: string,
  newName: string,
  newEmail: string,
  reason: string,
): Promise<{ successMessage: string; close: () => Promise<void> }> {
  const ctx = await browser.newContext();
  const rp = await ctx.newPage();
  await rp.goto(toTestUrl(link));
  await rp.getByLabel(/i agree to use electronic records/i).check();
  await rp.getByRole('button', { name: /i agree, continue/i }).click();

  await rp.getByRole('button', { name: /forward to someone else/i }).click();
  const dialog = rp.getByRole('dialog', { name: /forward to someone else/i });
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByLabel(/their full name/i).fill(newName);
  await dialog.getByLabel(/their email/i).fill(newEmail);
  await dialog.getByLabel(/reason/i).fill(reason);
  await dialog.getByRole('button', { name: /^send forward$/i }).click();

  const heading = rp.getByRole('heading', { name: /forwarded successfully/i });
  await heading.waitFor({ state: 'visible', timeout: 10000 });
  const successMessage = (await rp.getByText(/forwarded to/i).first().innerText()).trim();
  return { successMessage, close: () => ctx.close() };
}

/**
 * Sign as the delegate. The delegate MUST be shown the consent disclosure —
 * plan 018 fixed `reassignRecipient` to reset `consentGivenAt` /
 * `consentDisclosureVersion` on reassign specifically so a delegate can no
 * longer inherit the original recipient's consent timestamp and skip the
 * UETA/ESIGN disclosure. This is a required step, not tolerated-if-present:
 * if the checkbox never appears, that is the regression this guards against.
 */
async function delegateSigns(rp: Page, name: string): Promise<void> {
  const consentCheckbox = rp.getByLabel(/i agree to use electronic records/i);
  await consentCheckbox.waitFor({ state: 'visible', timeout: 5000 });
  await consentCheckbox.check();
  await rp.getByRole('button', { name: /i agree, continue/i }).click();

  const firstReq = rp.locator('button.sig-pulse').first();
  await firstReq.waitFor({ state: 'visible', timeout: 10000 });
  await firstReq.click();
  const modal = rp.locator('[role="dialog"]');
  await modal.waitFor({ state: 'visible' });
  await modal.getByRole('button', { name: /^type$/i }).click();
  await modal.getByPlaceholder(/type your full name/i).fill(name);
  await modal.getByRole('button', { name: /adopt.*sign/i }).click();
  await modal.waitFor({ state: 'hidden', timeout: 5000 });
  await rp.getByRole('button', { name: /finish.*submit/i }).click();
  await rp.getByRole('heading', { name: /document signed/i }).waitFor({ state: 'visible', timeout: 15000 });
}

test.describe.serial('reassign — recipient delegates signing to someone else', () => {
  test('reassign succeeds, delegate gets a fresh link, delegate signs, envelope completes; old link is dead', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);

    const ts = Date.now();
    const signerEmail = `signer-${ts}@example.com`;
    const delegateEmail = `delegate-${ts}@example.com`;
    const delegateName = 'Delegate Person';

    // 1-2. Build and send a one-signer envelope.
    await builderUploadAndContinue(page, {
      title: `Reassign Test ${ts}`,
      files: [{ name: 'reassign.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await makePdfBytes()) }],
    });
    await builderAddRecipient(page, 'Original Signer', signerEmail);
    await builderPlaceSignature(page);
    await builderSend(page);
    await expect(page).toHaveURL(/\/dashboard\/envelopes\/[a-z0-9]+$/);

    // 3. Fetch the original signing link.
    const originalLink = await waitForMailLink(signerEmail, /\/sign\//);
    expect(originalLink).not.toBeNull();

    // 4-5. Open the ceremony as the original recipient, reassign to the
    // delegate, and assert the reassign SUCCEEDED — the regression guard:
    // before plan 002 this returned "Email allowlist refused ...".
    const { successMessage, close: closeOriginal } = await reassignAtLink(
      browser,
      originalLink!,
      delegateName,
      delegateEmail,
      'Out of office; please have my colleague sign.',
    );
    expect(successMessage).toMatch(/forwarded to delegate person/i);
    expect(successMessage).toContain(delegateEmail);
    await closeOriginal();

    // 6. A fresh invite reaches the delegate, and the link differs from
    // the original recipient's link.
    const delegateLink = await waitForMailLink(delegateEmail, /\/sign\//);
    expect(delegateLink).not.toBeNull();
    expect(delegateLink).not.toBe(originalLink);

    // 7. Delegate signs; envelope reaches Completed.
    const ctx = await browser.newContext();
    const dp = await ctx.newPage();
    await dp.goto(toTestUrl(delegateLink!));
    await delegateSigns(dp, delegateName);
    await ctx.close();

    await page.reload();
    await expect(page.getByText(/^Completed$/).first()).toBeVisible({ timeout: 15000 });

    // 8. Negative test (CONTRIBUTING.md requires at least one per feature):
    // the original recipient's old link no longer works — the ceremony must
    // show an invalid/superseded state, not silently re-render as if valid.
    const staleCtx = await browser.newContext();
    const stalePage = await staleCtx.newPage();
    await stalePage.goto(toTestUrl(originalLink!));
    await expect(
      stalePage.getByRole('heading', { name: /already signed|signing unavailable/i }),
    ).toBeVisible({ timeout: 10000 });
    await staleCtx.close();
  });

  test('old link is dead immediately after reassign, before the delegate ever opens theirs (impersonation guard)', async ({ page, browser }) => {
    await ensureLoggedInAsAdmin(page);

    const ts = Date.now();
    const signerEmail = `signer-impersonation-${ts}@example.com`;
    const delegateEmail = `delegate-impersonation-${ts}@example.com`;
    const delegateName = 'Delegate Impersonation Target';

    // 1-2. Build and send a one-signer envelope.
    await builderUploadAndContinue(page, {
      title: `Reassign Impersonation Test ${ts}`,
      files: [{ name: 'reassign-imp.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await makePdfBytes()) }],
    });
    await builderAddRecipient(page, 'Original Signer', signerEmail);
    await builderPlaceSignature(page);
    await builderSend(page);
    await expect(page).toHaveURL(/\/dashboard\/envelopes\/[a-z0-9]+$/);

    // 3. Fetch the original signing link.
    const originalLink = await waitForMailLink(signerEmail, /\/sign\//);
    expect(originalLink).not.toBeNull();

    // 4. reassignAtLink() opens the original link (which pins tokenJti on
    // first load, via recordRecipientOpened), accepts consent, then
    // forwards to the delegate — this is the precondition that made bug 1
    // reachable: with the pre-fix code, reassign nulled tokenJti back out,
    // undoing this pin and turning the single-use guard into a no-op for
    // the old link.
    const { successMessage, close: closeOriginal } = await reassignAtLink(
      browser,
      originalLink!,
      delegateName,
      delegateEmail,
      'Testing the impersonation window.',
    );
    expect(successMessage).toMatch(/forwarded to delegate impersonation target/i);
    await closeOriginal();

    // 5. THE REGRESSION GUARD: assert the old link is already dead RIGHT
    // NOW — before the delegate has ever opened their new link. Before
    // plan 018's fix, this is exactly the window where the old link still
    // opened a live, signable ceremony under the DELEGATE's identity
    // (reassign had already overwritten the row's email/name), so whoever
    // held the stale link could sign as the delegate. Plan 017's existing
    // old-link check only runs after the envelope is fully completed,
    // where a different guard (`envelope_closed` / `recipient_done`)
    // independently blocks it — it does not exercise this earlier window.
    const staleCtx = await browser.newContext();
    const stalePage = await staleCtx.newPage();
    await stalePage.goto(toTestUrl(originalLink!));
    await expect(
      stalePage.getByRole('heading', { name: /already signed|signing unavailable/i }),
    ).toBeVisible({ timeout: 10000 });
    await staleCtx.close();

    // 6. The delegate's own fresh link, by contrast, must still work.
    const delegateLink = await waitForMailLink(delegateEmail, /\/sign\//);
    expect(delegateLink).not.toBeNull();
    expect(delegateLink).not.toBe(originalLink);
    const delegateCtx = await browser.newContext();
    const delegatePage = await delegateCtx.newPage();
    await delegatePage.goto(toTestUrl(delegateLink!));
    await expect(
      delegatePage.getByLabel(/i agree to use electronic records/i),
    ).toBeVisible({ timeout: 10000 });
    await delegateCtx.close();
  });
});
