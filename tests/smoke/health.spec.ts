import { test, expect } from '@playwright/test';

/**
 * Public-URL smoke suite. Run via `npm run smoke:public` AFTER the nginx
 * snippet has been installed and the proxy reloaded. Not part of the
 * standard test run.
 */
test('public /DocuRidge/healthz responds', async ({ request }) => {
  const res = await request.get('healthz');
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ status: 'ok' });
});

test('public /DocuRidge/readyz responds', async ({ request }) => {
  const res = await request.get('readyz');
  expect(res.status()).toBe(200);
});
