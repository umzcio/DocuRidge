import { describe, expect, it } from 'vitest';
import { fieldSuggestionSchema, pageSuggestionRequestSchema, filterDuplicateSuggestions, SUGGESTION_TYPES, MAX_PAGE_TEXT_CHARS } from './field-suggestions';

const field = { type: 'SIGNATURE' as const, page: 2, x: 0.1, y: 0.4, w: 0.3, h: 0.08, label: 'Sign here', confidence: 0.9 };

describe('field suggestion validation', () => {
  it('accepts every supported field type', () => {
    expect(SUGGESTION_TYPES).toHaveLength(12);
    for (const type of SUGGESTION_TYPES) expect(fieldSuggestionSchema.safeParse({ ...field, type }).success).toBe(true);
  });
  it.each([{ x: NaN }, { y: Infinity }, { w: 0 }, { h: -1 }, { x: 0.9 }, { y: 0.98 }, { page: 0 }, { page: 1.5 }, { confidence: 2 }, { type: 'FORMULA' }, { label: 'x'.repeat(161) }, { required: true }])('rejects invalid or unexpected output %j', (change) => {
    expect(fieldSuggestionSchema.safeParse({ ...field, ...change }).success).toBe(false);
  });
  it('accepts JPEG data only and limits page text', () => {
    const request = { image: 'data:image/jpeg;base64,/9j/2Q==', text: '', page: 1 };
    expect(pageSuggestionRequestSchema.safeParse(request).success).toBe(true);
    for (const image of ['https://secret.example/a.jpg', 'data:image/png;base64,/9j/2Q==', 'data:image/jpeg;base64,garbage']) {
      expect(pageSuggestionRequestSchema.safeParse({ ...request, image }).success).toBe(false);
    }
    expect(pageSuggestionRequestSchema.safeParse({ ...request, text: 'x'.repeat(MAX_PAGE_TEXT_CHARS + 1) }).success).toBe(false);
    expect(pageSuggestionRequestSchema.safeParse({ ...request, endpoint: 'https://other.example' }).success).toBe(false);
  });
  it('matches persisted field limits for pages, dimensions, and labels', () => {
    expect(fieldSuggestionSchema.safeParse({ ...field, page: 2000, w: 0.005, h: 0.005, label: 'x'.repeat(120) }).success).toBe(true);
    for (const change of [{ page: 2001 }, { w: 0.0049 }, { h: 0.0049 }, { label: 'x'.repeat(121) }]) {
      expect(fieldSuggestionSchema.safeParse({ ...field, ...change }).success).toBe(false);
    }
    expect(pageSuggestionRequestSchema.safeParse({ image: 'data:image/jpeg;base64,/9j/2Q==', text: '', page: 2001 }).success).toBe(false);
  });
  it('gives an empty label a readable field-type default', () => {
    expect(fieldSuggestionSchema.parse({ ...field, type: 'JOB_TITLE', label: '  ' }).label).toBe('Job title');
  });
});

describe('duplicate suggestions', () => {
  it('removes overlapping candidates of the same type against existing boxes and each other', () => {
    expect(filterDuplicateSuggestions([field, { ...field, x: 0.105 }, { ...field, x: 0.6 }], [])).toEqual([field, { ...field, x: 0.6 }]);
    const existing = { type: 'SIGNATURE', page: 2, x: 0.1, y: 0.4, w: 0.3, h: 0.08 };
    expect(filterDuplicateSuggestions([field], [existing])).toEqual([]);
  });
  it('keeps different pages, types, and nearby non-overlapping boxes', () => {
    const candidates = [{ ...field, page: 1 }, { ...field, type: 'DATE' as const }, { ...field, y: 0.5 }];
    expect(filterDuplicateSuggestions(candidates, [field])).toEqual(candidates);
  });
});
