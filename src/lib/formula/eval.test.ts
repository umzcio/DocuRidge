import { describe, it, expect } from 'vitest';
import { evaluateFormula, formatFormulaValue } from './eval';

describe('evaluateFormula', () => {
  it('adds two numeric refs', () => {
    expect(evaluateFormula('{a} + {b}', { a: '3', b: '4' })).toEqual({ ok: true, value: 7 });
  });

  it('respects operator precedence', () => {
    expect(evaluateFormula('2 + 3 * 4', {})).toEqual({ ok: true, value: 14 });
  });

  it('honors parentheses', () => {
    expect(evaluateFormula('(2 + 3) * 4', {})).toEqual({ ok: true, value: 20 });
  });

  it('handles unary minus', () => {
    expect(evaluateFormula('-5 + 10', {})).toEqual({ ok: true, value: 5 });
    expect(evaluateFormula('-(2 + 3)', {})).toEqual({ ok: true, value: -5 });
  });

  it('handles decimal arithmetic', () => {
    const r = evaluateFormula('{p} * 0.07', { p: '100' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeCloseTo(7);
  });

  it('reports missing refs as not-finite', () => {
    const r = evaluateFormula('{a} + 1', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('eval');
  });

  it('reports empty-string refs as not-finite', () => {
    const r = evaluateFormula('{a} + 1', { a: '' });
    expect(r.ok).toBe(false);
  });

  it('reports non-numeric refs as not-finite', () => {
    const r = evaluateFormula('{a} + 1', { a: 'hello' });
    expect(r.ok).toBe(false);
  });

  it('rejects unbalanced parens', () => {
    const r = evaluateFormula('(1 + 2', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('parse');
  });

  it('rejects unknown operators', () => {
    const r = evaluateFormula('1 ^ 2', {});
    expect(r.ok).toBe(false);
  });

  it('does not eval JS', () => {
    // Catches the obvious "naive Function() implementation" footgun.
    const r = evaluateFormula('process.exit(1)', {});
    expect(r.ok).toBe(false);
  });

  it('rejects empty formula', () => {
    expect(evaluateFormula('', {}).ok).toBe(false);
    expect(evaluateFormula('   ', {}).ok).toBe(false);
  });

  it('rejects empty {} ref', () => {
    expect(evaluateFormula('{} + 1', {}).ok).toBe(false);
  });

  it('rejects trailing tokens', () => {
    expect(evaluateFormula('1 + 2 3', {}).ok).toBe(false);
  });
});

describe('formatFormulaValue', () => {
  it('drops trailing fractional zeros for integers', () => {
    expect(formatFormulaValue(7)).toBe('7');
    expect(formatFormulaValue(0)).toBe('0');
  });

  it('preserves meaningful fractional part', () => {
    expect(formatFormulaValue(3.14)).toBe('3.14');
  });

  it('handles negatives', () => {
    expect(formatFormulaValue(-2)).toBe('-2');
    expect(formatFormulaValue(-0.5)).toBe('-0.5');
  });

  it('returns empty string for non-finite', () => {
    expect(formatFormulaValue(NaN)).toBe('');
    expect(formatFormulaValue(Infinity)).toBe('');
  });
});
