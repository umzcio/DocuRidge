import { describe, expect, it } from 'vitest';
import { FieldCapError, assertCanAddField, assertFieldCaps, getFieldCaps } from './field-caps';

/** `count` fields spread over pages of one document, `perPage` to a page. */
const spread = (count: number, perPage = 100, document: string | number = 'd1') =>
  Array.from({ length: count }, (_, i) => ({ document, page: Math.floor(i / perPage) + 1 }));

describe('field caps', () => {
  it('defaults to 2000 per envelope and 200 per page', () => {
    expect(getFieldCaps()).toEqual({ perEnvelope: 2000, perPage: 200 });
  });

  it('passes at the envelope cap and refuses one past it', () => {
    expect(() => assertFieldCaps(spread(2000))).not.toThrow();
    expect(() => assertFieldCaps(spread(2001))).toThrow(new FieldCapError('An envelope can have at most 2000 fields.'));
  });

  it('refuses 201 fields on one page of one document', () => {
    expect(() => assertFieldCaps(spread(201, 201))).toThrow('A page can have at most 200 fields.');
  });

  it('counts a page per document', () => {
    const fields = [...spread(200, 200, 'd1'), ...spread(200, 200, 'd2')];
    expect(() => assertFieldCaps(fields)).not.toThrow();
  });

  it('reads the caps from the environment', () => {
    process.env.ENVELOPE_MAX_FIELDS = '5';
    try {
      expect(getFieldCaps().perEnvelope).toBe(5);
    } finally {
      delete process.env.ENVELOPE_MAX_FIELDS;
    }
  });

  it('checks one more field against existing counts', () => {
    expect(() => assertCanAddField({ envelopeCount: 1999, pageCount: 199 })).not.toThrow();
    expect(() => assertCanAddField({ envelopeCount: 2000, pageCount: 0 })).toThrow(/at most 2000 fields/);
    expect(() => assertCanAddField({ envelopeCount: 10, pageCount: 200 })).toThrow(/at most 200 fields/);
  });
});
