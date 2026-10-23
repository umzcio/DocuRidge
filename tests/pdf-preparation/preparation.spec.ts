import { test, expect, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

test.beforeEach(({ page }) => { page.on('pageerror', error => { throw error; }); });

async function upload(page: Page, fixture?: Uint8Array) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    const p = pdf.addPage([600, 800]);
    p.drawText(`Contract page ${i}`, { x: 50, y: 700, font });
    p.drawText('Signature: ____________________', { x: 50, y: 100, font, size: 12 });
  }
  await page.goto('/');
  await page.getByLabel('Add PDF documents').setInputFiles({ name: 'contract.pdf', mimeType: 'application/pdf', buffer: Buffer.from(fixture ?? await pdf.save()) });
  await expect(page.getByText('contract.pdf', { exact: true })).toBeVisible();
}
async function prepare(page: Page, fixture?: Uint8Array) {
  await upload(page, fixture);
  await page.getByRole('button', { name: /continue to prepare/i }).click();
  await page.getByTestId('builder-add-recipient').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Alice');
  await dialog.getByLabel('Email', { exact: true }).fill('alice@example.test');
  await dialog.getByRole('button', { name: 'Add recipient', exact: true }).click();
}

test('rotation, annotations, undo and deletion reach submitted PDF bytes', async ({ page }) => {
  await upload(page);
  await page.getByRole('button', { name: 'Edit PDF', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('[data-pdf-preview]')).toHaveAttribute('data-loaded', 'true');
  await dialog.getByRole('button', { name: 'Rotate right', exact: true }).click();
  await expect(dialog.locator('[data-pdf-preview]')).toHaveAttribute('data-loaded', 'true');
  await dialog.getByRole('button', { name: 'Move later', exact: true }).click();
  await expect(dialog.getByText('Page 2 of 2', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
  await dialog.getByRole('button', { name: /^Page 1/ }).click();
  await dialog.getByRole('button', { name: 'Add text', exact: true }).click();
  await dialog.getByLabel('Text to add').fill('Reviewed by Alice');
  await expect(dialog.locator('[data-pdf-preview]')).toHaveAttribute('data-loaded', 'true');
  await dialog.locator('[data-editor-page]').click({ position: { x: 70, y: 70 } });
  await dialog.getByRole('button', { name: /^Page 2/ }).click();
  await dialog.getByRole('button', { name: 'Delete page', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('pdf-editor.png') });
  await dialog.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/1 page ·/)).toBeVisible();
  await page.getByRole('button', { name: /continue to prepare/i }).click();
  await page.getByRole('button', { name: /save draft/i }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__submittedPdf?.length || 0)).toBeGreaterThan(0);
  const bytes = await page.evaluate(() => (window as any).__submittedPdf as number[]);
  const result = await PDFDocument.load(new Uint8Array(bytes));
  expect(result.getPageCount()).toBe(1);
  expect(result.getPage(0).getSize()).toEqual({ width: 800, height: 600 });
  expect(result.getPage(0).getRotation().angle).toBe(0);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const contents = await (await doc.getPage(1)).getTextContent();
  const text = contents.items.filter(item => 'str' in item).map(item => 'str' in item ? item.str : '').join(' ');
  expect(text).toContain('Reviewed by Alice');
  expect(text).toContain('Contract page 1');
  expect(text).not.toContain('Contract page 2');
  await doc.destroy();
});

test('AI suggests, reviews, assigns and deduplicates fields in the actual builder', async ({ page }) => {
  const requests: { page: number; image: string; text: string }[] = [];
  await page.route('**/api/ai/field-suggestions', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { enabled: true } });
    const input = route.request().postDataJSON(); requests.push(input);
    await route.fulfill({ json: { suggestions: input.page === 1 ? [
      { type: 'SIGNATURE', page: 1, x: 0.1, y: 0.7, w: 0.3, h: 0.06, label: 'Employee signature', confidence: 0.94 },
      { type: 'DATE', page: 1, x: 0.5, y: 0.7, w: 0.15, h: 0.04, label: 'Signing date', confidence: 0.88 },
    ] : [] } });
  });
  await prepare(page);
  await page.getByRole('button', { name: 'AI: Suggest fields', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Analyze document', exact: true }).click();
  await expect(dialog.getByText('2 selected · 2 suggestions')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add 2 selected fields' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Review Employee signature' }).click();
  await expect(dialog.getByLabel('Required field', { exact: true })).toBeChecked();
  await dialog.getByLabel('Required field', { exact: true }).check();
  await dialog.getByLabel('Left (%)').fill('12');
  await page.screenshot({ path: test.info().outputPath('ai-suggestions.png') });
  await dialog.getByLabel('Include Signing date').uncheck();
  await dialog.getByRole('button', { name: 'Add 1 selected fields' }).click();
  await expect(dialog).toBeHidden();
  const first = await page.locator('input[name=fields]').inputValue();
  expect(JSON.parse(first)).toEqual([expect.objectContaining({ type: 'SIGNATURE', x: 0.12, required: true, dataLabel: 'Employee signature' })]);
  expect(requests).toHaveLength(2);
  expect(requests[0]!.image).toMatch(/^data:image\/jpeg;base64,/);
  expect(requests[0]!.text).toContain('Contract page 1');
  await page.getByRole('button', { name: 'AI: Suggest fields', exact: true }).click();
  await dialog.getByRole('button', { name: 'Analyze document', exact: true }).click();
  await expect(dialog.getByText('1 selected · 1 suggestions')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(JSON.parse(await page.locator('input[name=fields]').inputValue())).toHaveLength(1);
  await page.getByRole('button', { name: 'Edit PDF', exact: true }).last().click();
  await dialog.getByRole('button', { name: 'Rotate right', exact: true }).click();
  await dialog.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(JSON.parse(await page.locator('input[name=fields]').inputValue())[0]).toEqual(expect.objectContaining({ x: 0.24000000000000005, y: 0.12, w: 0.06, h: 0.3 }));
});

test('invalid PDF is rejected immediately', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Add PDF documents').setInputFiles({ name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a PDF') });
  await expect(page.getByText(/Unable to open this PDF/)).toBeVisible();
  await expect(page.getByRole('button', { name: /continue to prepare/i })).not.toBeVisible();
});

test('analysis before adding a signer can be applied without losing or rerunning suggestions', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/ai/field-suggestions', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { enabled: true } });
    calls++;
    return route.fulfill({ json: { suggestions: [{ type: 'SIGNATURE', page: route.request().postDataJSON().page, x: .1, y: .7, w: .3, h: .06, label: 'Signature', confidence: .9 }] } });
  });
  await upload(page);
  await page.getByRole('button', { name: /continue to prepare/i }).click();
  await page.getByRole('button', { name: 'AI: Suggest fields', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Analyze document', exact: true }).click();
  await expect(dialog.getByText('2 selected · 2 suggestions')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add 2 selected fields' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Add signer', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Enter the signer’s name.');
  await dialog.getByLabel('Signer name', { exact: true }).fill('Alice');
  await dialog.getByLabel('Signer email', { exact: true }).fill('invalid-email');
  await dialog.getByRole('button', { name: 'Add signer', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Enter a valid email address.');
  await dialog.getByLabel('Signer email', { exact: true }).fill('alice@example.test');
  await dialog.getByLabel('Signer email', { exact: true }).press('Enter');
  expect(await page.evaluate(() => (window as any).__submittedPdf)).toBeUndefined();
  await expect(dialog.getByRole('button', { name: 'Add 2 selected fields' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Add 2 selected fields' }).click();
  await expect(dialog).toBeHidden();
  const fields = JSON.parse(await page.locator('input[name=fields]').inputValue());
  const recipients = JSON.parse(await page.locator('input[name=recipients]').inputValue());
  expect(calls).toBe(2);
  expect(recipients).toHaveLength(1);
  expect(recipients[0]).toMatchObject({ name: 'Alice', email: 'alice@example.test', role: 'SIGNER' });
  expect(fields).toHaveLength(2);
  expect(fields.every((f: { recipientClientId: string }) => f.recipientClientId === recipients[0].clientId)).toBe(true);
});

for (const suggestedTop of [.67, .7, .712]) test(`AI signature placement aligns to the visible signing line before review and apply (top=${suggestedTop})`, async ({ page }) => {
  const pdf = await PDFDocument.create();
  const p = pdf.addPage([600, 800]);
  p.drawLine({ start: { x: 60, y: 240 }, end: { x: 240, y: 240 }, thickness: 1 });
  p.drawText('Signature', { x: 60, y: 222, size: 11 });
  await page.route('**/api/ai/field-suggestions', route => route.fulfill({ json: route.request().method() === 'GET' ? { enabled: true } : {
    suggestions: [{ type: 'SIGNATURE', page: 1, x: .11, y: suggestedTop, w: .28, h: .04, label: 'Signature', confidence: .94 }],
  } }));
  await prepare(page, await pdf.save());
  await page.getByRole('button', { name: 'AI: Suggest fields', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Analyze document', exact: true }).click();
  await dialog.getByRole('button', { name: 'Review Signature', exact: true }).click();
  await expect(dialog.getByLabel('Left (%)')).toHaveValue('10');
  await expect(dialog.getByLabel('Top (%)')).toHaveValue('66');
  await dialog.getByRole('button', { name: 'Add 1 selected fields' }).click();
  const [field] = JSON.parse(await page.locator('input[name=fields]').inputValue());
  expect(field.x).toBeCloseTo(.1, 2);
  expect(field.w).toBeCloseTo(.3, 2);
  expect(field.y + field.h).toBeCloseTo(.7, 3);
});

test('AI checkboxes align to printed squares in vertical and horizontal groups', async ({ page }) => {
  const pdf = await PDFDocument.create();
  const p = pdf.addPage([792, 612]);
  const squares = [{ x: 700, y: 540 }, { x: 700, y: 515 }, { x: 700, y: 490 }, { x: 180, y: 60 }, { x: 250, y: 60 }, { x: 320, y: 60 }, { x: 390, y: 60 }];
  squares.forEach((b, i) => {
    p.drawRectangle({ x: b.x, y: b.y, width: 12, height: 12, borderWidth: .6, borderColor: rgb(0, 0, 0) });
    p.drawText(`Option ${i + 1}`, { x: b.x + 16, y: b.y + 2, size: 8 });
  });
  await page.route('**/api/ai/field-suggestions', route => route.fulfill({ json: route.request().method() === 'GET' ? { enabled: true } : {
    suggestions: squares.map((b, i) => ({ type: 'CHECKBOX', page: 1, x: b.x / 792 - .012, y: 1 - (b.y + 12) / 612 - .01, w: .024, h: .024, label: `Option ${i + 1}`, confidence: .9 })),
  } }));
  await prepare(page, await pdf.save());
  await page.getByRole('button', { name: 'AI: Suggest fields', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Analyze document', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add 7 selected fields' }).click();
  const fields = JSON.parse(await page.locator('input[name=fields]').inputValue());
  expect(fields).toHaveLength(7);
  fields.forEach((f: { x: number; y: number; w: number; h: number }, i: number) => {
    expect(f.x).toBeCloseTo(squares[i]!.x / 792, 2);
    expect(f.y).toBeCloseTo(1 - (squares[i]!.y + 12) / 612, 2);
    expect(f.w).toBeCloseTo(12 / 792, 2);
    expect(f.h).toBeCloseTo(12 / 612, 2);
    expect(Math.abs(f.w * 792 - f.h * 612)).toBeLessThan(1);
  });
});

test('AI preserves partial results and retries only failed pages', async ({ page }) => {
  const calls: number[] = [];
  await page.route('**/api/ai/field-suggestions', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { enabled: true } });
    const { page: p } = route.request().postDataJSON(); calls.push(p);
    if (p === 2 && calls.filter(n => n === 2).length === 1) return route.fulfill({ status: 502, json: { error: 'AI analysis failed. Retry this page.' } });
    return route.fulfill({ json: { suggestions: [{ type: 'SIGNATURE', page: p, x: .1, y: .7, w: .3, h: .06, label: `Signature ${p}`, confidence: .9 }] } });
  });
  await prepare(page);
  await page.getByRole('button', { name: 'AI: Suggest fields', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Analyze document', exact: true }).click();
  await expect(dialog.getByText('1 selected · 1 suggestions')).toBeVisible();
  await dialog.getByRole('button', { name: 'Retry failed pages', exact: true }).click();
  await expect(dialog.getByText('2 selected · 2 suggestions')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add 2 selected fields' })).toBeEnabled();
  expect(calls).toEqual([1, 2, 2]);
  await dialog.getByRole('button', { name: 'Add 2 selected fields' }).click();
  const fields = JSON.parse(await page.locator('input[name=fields]').inputValue());
  expect(fields).toHaveLength(2);
  expect(fields.every((f: { type: string; required: boolean }) => f.required === (f.type === 'SIGNATURE' || f.type === 'INITIALS'))).toBe(true);
});

test('closing AI analysis discards late results', async ({ page }) => {
  let pending: import('@playwright/test').Route | undefined;
  await page.route('**/api/ai/field-suggestions', async route => {
    if (route.request().method() === 'GET') await route.fulfill({ json: { enabled: true } });
    else pending = route;
  });
  await prepare(page);
  await page.getByRole('button', { name: 'AI: Suggest fields', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Analyze document', exact: true }).click();
  await expect.poll(() => !!pending).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await pending!.fulfill({ json: { suggestions: [{ type: 'SIGNATURE', page: 1, x: .1, y: .7, w: .3, h: .06, label: 'Late signature', confidence: .9 }] } }).catch(() => {});
  await expect(dialog).toBeHidden();
  expect(JSON.parse(await page.locator('input[name=fields]').inputValue())).toEqual([]);
});

test('annotation preview matches the saved PDF rendering', async ({ page }) => {
  await upload(page);
  await page.getByRole('button', { name: 'Edit PDF', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const canvas = dialog.locator('[data-pdf-preview] canvas');
  await expect(dialog.locator('[data-pdf-preview]')).toHaveAttribute('data-loaded', 'true');
  const before = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
  await dialog.getByRole('button', { name: 'Add text', exact: true }).click();
  await dialog.getByLabel('Text to add').fill('This longer annotation must use the same font, size, position and layout in both the preview and the PDF sent for signing.');
  await dialog.locator('[data-editor-page]').click({ position: { x: 60, y: 60 } });
  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL())).not.toBe(before);
  await expect(dialog.getByText('Updating annotation preview…')).not.toBeVisible();
  await expect(dialog.locator('[data-pdf-preview]')).toHaveAttribute('data-loaded', 'true');
  const preview = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
  await dialog.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Edit PDF', exact: true }).click();
  await expect(dialog.locator('[data-pdf-preview]')).toHaveAttribute('data-loaded', 'true');
  expect(await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL())).toBe(preview);
});
