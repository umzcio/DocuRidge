// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Select } from './select';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement('div'); document.body.appendChild(host);
let root = createRoot(host);
afterEach(async () => { await act(() => root.unmount()); root = createRoot(host); });

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'COMPLETED', label: 'completed' },
];

describe('Select', () => {
  it("shows an option whose value is '' as selected, not as the placeholder", async () => {
    await act(async () => root.render(<Select value="" onChange={() => {}} options={STATUS_OPTIONS} ariaLabel="Status" />));
    const trigger = host.querySelector('button[aria-label="Status"]')!;
    expect(trigger.textContent).toContain('All statuses');
    expect(trigger.querySelector('[data-placeholder]')).toBeNull();
  });

  it("keeps '' as the placeholder when no option has that value", async () => {
    await act(async () => root.render(<Select value="" onChange={() => {}} options={STATUS_OPTIONS.slice(1)} placeholder="— Select —" ariaLabel="Status" />));
    expect(host.querySelector('button[aria-label="Status"]')!.textContent).toContain('— Select —');
  });

  it("submits '' for the empty option and never the internal sentinel", async () => {
    await act(async () => root.render(<form><Select name="status" value="" onChange={() => {}} options={STATUS_OPTIONS} /></form>));
    const data = new FormData(host.querySelector('form')!);
    expect(data.getAll('status')).toEqual(['']);
  });
});
