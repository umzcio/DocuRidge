// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PdfEditor } from './pdf-editor';
vi.mock('./pdf-preview', () => ({ PdfPreview: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement('div');
document.body.appendChild(host);
let root = createRoot(host);
afterEach(async () => { await act(() => root.unmount()); root = createRoot(host); });
function button(name: string) {
  const el = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === name);
  if (!el) throw new Error(`Missing button: ${name}`);
  return el;
}
describe('PDF editor', () => {
  it('stages page edits, supports undo and leaves the file untouched on cancel', async () => {
    const apply = vi.fn(); const close = vi.fn();
    await act(() => root.render(<PdfEditor file={new File(['pdf'], 'contract.pdf')} pageCount={2} fields={[]} onApply={apply} onClose={close} />));
    await act(() => button('Delete page').click());
    expect(document.body.textContent).toContain('1 of 1');
    await act(() => button('Undo').click());
    expect(document.body.textContent).toContain('1 of 2');
    await act(() => button('Cancel').click());
    expect(apply).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it('cannot delete the last remaining page', async () => {
    await act(() => root.render(<PdfEditor file={new File(['pdf'], 'contract.pdf')} pageCount={1} fields={[]} onApply={() => {}} onClose={() => {}} />));
    expect(button('Delete page').disabled).toBe(true);
  });
});
