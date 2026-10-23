// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldSuggestionsDialog } from './field-suggestions-dialog';
vi.mock('./pdf-preview', () => ({ PdfPreview: () => <div>Page preview</div>, openBrowserPdf: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement('div'); document.body.appendChild(host);
let root = createRoot(host);
afterEach(async () => { await act(() => root.unmount()); root = createRoot(host); vi.unstubAllGlobals(); });
describe('AI suggestions dialog', () => {
  it('explains missing configuration instead of pretending to detect fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ enabled: false }))));
    await act(async () => root.render(<FieldSuggestionsDialog file={new File(['pdf'], 'contract.pdf')} pageCount={1} existingFields={[]} recipients={[]} onApply={() => {}} onClose={() => {}} />));
    expect(document.body.textContent).toContain('AI field detection is not configured');
    expect([...document.querySelectorAll('button')].find(b => b.textContent === 'Analyze document')?.disabled).toBe(true);
  });
  it('does not add fields just by opening or closing the dialog', async () => {
    const apply = vi.fn(); const close = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ enabled: true }))));
    await act(async () => root.render(<FieldSuggestionsDialog file={new File(['pdf'], 'contract.pdf')} pageCount={1} existingFields={[]} recipients={[]} onApply={apply} onClose={close} />));
    await act(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Cancel')!.click());
    expect(apply).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
  });
});
