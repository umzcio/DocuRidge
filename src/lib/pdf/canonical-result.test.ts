import { describe, expect, it } from 'vitest';
import { getPdfSealLimits } from './seal-limits';
import {
  CANONICAL_REFUSAL_MESSAGES,
  canonicalRefusalUploadCode,
  parseCanonicalizeResult,
  type CanonicalRefusalKey,
} from './canonical-result';

const pdfBytes = (size = 64) => {
  const bytes = new Uint8Array(size);
  bytes.set(Buffer.from('%PDF-1.7\n', 'latin1'));
  return bytes;
};

const valid = () => ({ ok: true, bytes: pdfBytes(), pageCount: 2, sealCost: { pages: 2, objects: 40, bytes: 1000 } });

describe('parseCanonicalizeResult', () => {
  it('passes a valid result', () => {
    const input = valid();
    expect(parseCanonicalizeResult(input)).toEqual(input);
  });

  it.each([
    ['a missing %PDF- header', { bytes: new Uint8Array(64) }],
    ['oversize bytes', { bytes: pdfBytes(getPdfSealLimits().maxSealBytes + 1) }],
    ['empty bytes', { bytes: new Uint8Array(0) }],
    ['bytes that are not a Uint8Array', { bytes: Array.from(pdfBytes()) }],
    ['a pageCount of 0', { pageCount: 0, sealCost: { pages: 0, objects: 40, bytes: 1000 } }],
    ['a pageCount over the cap', {
      pageCount: getPdfSealLimits().maxPages + 1,
      sealCost: { pages: getPdfSealLimits().maxPages + 1, objects: 40, bytes: 1000 },
    }],
    ['a fractional pageCount', { pageCount: 1.5 }],
    ['a sealCost.pages mismatch', { sealCost: { pages: 3, objects: 40, bytes: 1000 } }],
    ['a sealCost over the object cap', { sealCost: { pages: 2, objects: getPdfSealLimits().maxSealObjects + 1, bytes: 1000 } }],
    ['a sealCost over the byte cap', { sealCost: { pages: 2, objects: 40, bytes: getPdfSealLimits().maxSealBytes + 1 } }],
    ['a negative sealCost', { sealCost: { pages: 2, objects: -1, bytes: 1000 } }],
    ['a missing sealCost', { sealCost: undefined }],
  ])('refuses %s as pdf_too_complex', (_name, patch) => {
    expect(parseCanonicalizeResult({ ...valid(), ...patch })).toEqual({ ok: false, key: 'pdf_too_complex' });
  });

  it.each([null, undefined, 'ok', 7, {}, { ok: 'true' }])('refuses the malformed answer %j as pdf_too_complex', (x) => {
    expect(parseCanonicalizeResult(x)).toEqual({ ok: false, key: 'pdf_too_complex' });
  });

  it('refuses an unknown key as pdf_too_complex', () => {
    expect(parseCanonicalizeResult({ ok: false, key: 'something_else' })).toEqual({ ok: false, key: 'pdf_too_complex' });
    expect(parseCanonicalizeResult({ ok: false, key: 'toString' })).toEqual({ ok: false, key: 'pdf_too_complex' });
  });

  it.each([...Object.keys(CANONICAL_REFUSAL_MESSAGES), 'encrypted'])('accepts the known key %s', (key) => {
    expect(parseCanonicalizeResult({ ok: false, key })).toEqual({ ok: false, key });
  });

  it('drops a child message on a hidden_layers refusal', () => {
    expect(parseCanonicalizeResult({ ok: false, key: 'hidden_layers', message: 'Export a flattened PDF <script>' }))
      .toEqual({ ok: false, key: 'hidden_layers' });
  });

  it('passes a short /flattened PDF/ message through on unsupported_form only', () => {
    const message = 'This PDF uses XFA forms. Export a flattened PDF first.';
    expect(parseCanonicalizeResult({ ok: false, key: 'unsupported_form', message })).toEqual({ ok: false, key: 'unsupported_form', message });
    expect(parseCanonicalizeResult({ ok: false, key: 'unsupported_form', message: 'Visit evil.example' }))
      .toEqual({ ok: false, key: 'unsupported_form' });
    expect(parseCanonicalizeResult({ ok: false, key: 'unsupported_form', message: `${'x'.repeat(300)} flattened PDF` }))
      .toEqual({ ok: false, key: 'unsupported_form' });
  });
});

describe('canonical refusal table', () => {
  it('maps every key to its upload code', () => {
    const codes: Record<CanonicalRefusalKey, string> = {
      need_appearances: 'unsupported_form',
      visible_annotations: 'unsupported_content',
      hidden_layers: 'unsupported_content',
      self_check: 'unreadable_pdf',
      unsupported_form: 'unsupported_form',
      no_pages: 'unreadable_pdf',
      unreadable_pdf: 'unreadable_pdf',
      pdf_too_complex: 'pdf_too_complex',
    };
    for (const [key, code] of Object.entries(codes)) {
      expect(canonicalRefusalUploadCode(key as CanonicalRefusalKey)).toBe(code);
    }
  });

  it('uses the fixed messages', () => {
    expect(CANONICAL_REFUSAL_MESSAGES.need_appearances).toBe(
      'This PDF form asks the viewer to redraw its fields, so it may not look the same when signed. Export a flattened PDF first.',
    );
    expect(CANONICAL_REFUSAL_MESSAGES.hidden_layers).toMatch(/^This PDF has hidden layers/);
    expect(CANONICAL_REFUSAL_MESSAGES.no_pages).toBe('PDF has no pages.');
  });
});
