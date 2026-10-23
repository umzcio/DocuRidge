import { describe, expect, it } from 'vitest';
import { checkFieldPattern, MAX_FIELD_PATTERN_LENGTH } from './pattern';
import { testFieldPattern } from './pattern-server';

describe('checkFieldPattern', () => {
  it.each([
    '^\\d{3}-\\d{4}$',
    '^[A-Z]{2}\\d+$',
    '^(\\+1)?\\d{10}$',
    '^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$',
    '^(abc)+$',
    '^(?:AL|AK|AZ)$',
    '^\\p{Lu}{2}$',
    '^[(+]\\d+$',
    'a{2}',
    '^\\$\\d+(\\.\\d{2})?$',
  ])('accepts %s', (pattern) => {
    expect(checkFieldPattern(pattern)).toEqual({ ok: true });
  });

  it.each([
    ['^(a+)+$', /nested/i],
    ['^(a*)*$', /nested/i],
    ['^(\\d+){2,}$', /nested/i],
    ['^(?:x\\d*)+$', /nested/i],
    ['^((ab)*c)+$', /nested/i],
    ['^(a|a)*$', /alternat/i],
    ['^(a|aa){1,30}$', /alternat/i],
    ['^(\\u{2,})+$', /nested/i],
    ['^(a)\\1$', /back-?reference/i],
    ['^(?<x>a)\\k<x>$', /back-?reference/i],
    ['^(a', /valid regular expression/i],
    ['x'.repeat(MAX_FIELD_PATTERN_LENGTH + 1), /characters or fewer/i],
  ])('rejects %s', (pattern, reason) => {
    const result = checkFieldPattern(pattern);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });
});

describe('testFieldPattern', () => {
  it('matches and mismatches ordinary patterns', () => {
    expect(testFieldPattern('^\\d{5}$', '59812')).toBe('match');
    expect(testFieldPattern('^\\d{5}$', '5981')).toBe('mismatch');
  });

  it('reports a pattern that does not compile', () => {
    expect(testFieldPattern('^(a', 'a')).toBe('invalid');
  });

  it('stops a catastrophic pattern instead of blocking the process', () => {
    const started = Date.now();
    expect(testFieldPattern('^(a+)+$', `${'a'.repeat(40)}!`)).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
