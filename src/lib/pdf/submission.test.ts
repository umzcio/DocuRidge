import { describe, expect, it } from 'vitest';
import { redirect } from 'next/navigation';
import { submitEnvelopeSafely } from './submission';

describe('envelope submission recovery', () => {
  it('keeps a validation response available for correction and preserves the submitted intent and files', async () => {
    const data = new FormData();
    data.set('intent', 'save');
    data.append('document', new File(['first PDF'], 'first.pdf'));
    data.append('document', new File(['edited PDF'], 'second.pdf'));
    const validation = { ok: false, error: 'Title is required', fieldErrors: { title: 'Title is required' } };
    const result = await submitEnvelopeSafely({ ok: false }, data, async (_previous, submitted) => {
      expect(submitted.get('intent')).toBe('save');
      expect(await Promise.all(submitted.getAll('document').map(file => (file as File).text()))).toEqual(['first PDF', 'edited PDF']);
      return validation;
    });
    expect(result).toBe(validation);
  });

  it('reports an unknown outcome after transport failure and prevents a duplicate retry', async () => {
    let requests = 0;
    const invoke = async () => { requests++; throw new TypeError('Failed to fetch'); };
    const result = await submitEnvelopeSafely({ ok: false }, new FormData(), invoke);
    expect(result).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(result.error).toMatch(/dashboard.*before.*retry/i);
    expect(await submitEnvelopeSafely(result, new FormData(), invoke)).toEqual(result);
    expect(requests).toBe(1);
  });

  it('allows Next redirect control flow to complete a successful submission', async () => {
    await expect(submitEnvelopeSafely({ ok: false }, new FormData(), async () => {
      redirect('/dashboard/envelopes/sent');
    })).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT;') });
  });

  it('rejects aggregate uploads before the 50 MiB request limit and allows correction without sending twice', async () => {
    const data = new FormData();
    const file = new File([new Uint8Array(25 * 1024 * 1024)], 'document.pdf');
    data.append('document', file);
    data.append('document', file);
    let requests = 0;
    const invoke = async () => { requests++; return { ok: true }; };
    const result = await submitEnvelopeSafely({ ok: false }, data, invoke);
    expect(result.error).toMatch(/combined.*size|total.*size/i);
    expect(result.outcomeUnknown).not.toBe(true);
    expect(requests).toBe(0);
    data.set('document', file);
    expect(await submitEnvelopeSafely(result, data, invoke)).toEqual({ ok: true });
    expect(requests).toBe(1);
  });

  it('counts UTF-8 metadata bytes together with PDF bytes', async () => {
    const data = new FormData();
    data.append('document', new File([new Uint8Array(47 * 1024 * 1024)], 'document.pdf'));
    data.set('fields', '界'.repeat(1024 * 1024));
    let invoked = false;
    const result = await submitEnvelopeSafely({ ok: false }, data, async () => { invoked = true; return { ok: true }; });
    expect(result.ok).toBe(false);
    expect(result.outcomeUnknown).not.toBe(true);
    expect(invoked).toBe(false);
  });
});
