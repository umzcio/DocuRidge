import { describe, expect, it } from 'vitest';
import { csvCell, csvRow, neutraliseFormula } from './csv';

describe('neutraliseFormula — OWASP CSV injection triggers', () => {
  it.each([
    ['=HYPERLINK("https://evil/?x","Jane Doe")'],
    ['+1+1'],
    ['-2+3'],
    ['@SUM(A1:A2)'],
    ['\t=1+1'],
    ['\r=1+1'],
    ['\n=1+1'],
    ['  =1+1'],
    ['＝1+1'],
  ])('prefixes %j with a single quote', (value) => {
    expect(neutraliseFormula(value)).toBe(`'${value}`);
  });

  it.each([['Jane Doe'], ['jane@example.com'], ['2026-08-29'], ['10'], [''], ["O'Brien"], ['a=b']])(
    'leaves %j unchanged',
    (value) => {
      expect(neutraliseFormula(value)).toBe(value);
    },
  );
});

describe('csvCell', () => {
  it('always wraps the value in double quotes', () => {
    expect(csvCell('Offer letter')).toBe('"Offer letter"');
    expect(csvCell('')).toBe('""');
  });

  it('doubles embedded quotes and keeps separators and newlines inside the quotes', () => {
    expect(csvCell('A "special", multi\nline;title')).toBe('"A ""special"", multi\nline;title"');
  });

  it('neutralises a formula and still escapes its quotes', () => {
    expect(csvCell('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`);
  });

  it('accepts numbers', () => {
    expect(csvCell(10)).toBe('"10"');
  });
});

describe('csvRow', () => {
  it('joins encoded cells with commas', () => {
    expect(csvRow(['a', '=b', 'c,d'])).toBe(`"a","'=b","c,d"`);
  });
});
