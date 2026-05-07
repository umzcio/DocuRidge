/**
 * Tiny formula evaluator for FORMULA fields.
 *
 * Grammar (recursive-descent):
 *   expr   := term   (('+' | '-') term)*
 *   term   := factor (('*' | '/') factor)*
 *   factor := NUMBER | REF | '(' expr ')' | '-' factor
 *   REF    := '{' [^}]+ '}'
 *
 * Refs resolve to a runtime values map. Empty / non-numeric refs produce NaN
 * which makes the whole expression NaN; the caller renders that as "" so the
 * formula displays blank until all dependencies are filled.
 *
 * Strings are NOT supported. Numbers only — multiplication, addition, etc.
 * Comparison / boolean / function calls are not supported. The evaluator is
 * deterministic, has no I/O, no globals, and no `eval` — safe to run on user
 * input on both client and server.
 */

export interface FormulaError { kind: 'parse' | 'eval'; message: string; at?: number }

export type FormulaResult =
  | { ok: true; value: number }
  | { ok: false; error: FormulaError };

interface Token { kind: 'num' | 'ref' | 'op' | 'lparen' | 'rparen'; value: string; pos: number }

function tokenize(src: string): Token[] | FormulaError {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '+' || c === '-' || c === '*' || c === '/') {
      tokens.push({ kind: 'op', value: c, pos: i });
      i++;
      continue;
    }
    if (c === '(') { tokens.push({ kind: 'lparen', value: c, pos: i }); i++; continue; }
    if (c === ')') { tokens.push({ kind: 'rparen', value: c, pos: i }); i++; continue; }
    if (c === '{') {
      const close = src.indexOf('}', i + 1);
      if (close < 0) return { kind: 'parse', message: 'Unclosed { …', at: i };
      const ref = src.slice(i + 1, close).trim();
      if (!ref) return { kind: 'parse', message: 'Empty {} reference', at: i };
      tokens.push({ kind: 'ref', value: ref, pos: i });
      i = close + 1;
      continue;
    }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i;
      while (j < src.length && (
        (src[j]! >= '0' && src[j]! <= '9') || src[j] === '.'
      )) j++;
      tokens.push({ kind: 'num', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    return { kind: 'parse', message: `Unexpected character "${c}"`, at: i };
  }
  return tokens;
}

class Parser {
  private i = 0;
  constructor(private tokens: Token[], private values: Record<string, string>) {}

  parseExpr(): number { return this.parseAddSub(); }

  private peek(): Token | undefined { return this.tokens[this.i]; }

  private consume(): Token | undefined { return this.tokens[this.i++]; }

  private parseAddSub(): number {
    let left = this.parseMulDiv();
    while (true) {
      const t = this.peek();
      if (!t || t.kind !== 'op' || (t.value !== '+' && t.value !== '-')) break;
      this.consume();
      const right = this.parseMulDiv();
      left = t.value === '+' ? left + right : left - right;
    }
    return left;
  }

  private parseMulDiv(): number {
    let left = this.parseUnary();
    while (true) {
      const t = this.peek();
      if (!t || t.kind !== 'op' || (t.value !== '*' && t.value !== '/')) break;
      this.consume();
      const right = this.parseUnary();
      left = t.value === '*' ? left * right : left / right;
    }
    return left;
  }

  private parseUnary(): number {
    const t = this.peek();
    if (t && t.kind === 'op' && t.value === '-') {
      this.consume();
      return -this.parseUnary();
    }
    return this.parseAtom();
  }

  private parseAtom(): number {
    const t = this.consume();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.kind === 'num') return Number(t.value);
    if (t.kind === 'ref') {
      const v = this.values[t.value];
      if (v === undefined || v === '') return NaN;
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    }
    if (t.kind === 'lparen') {
      const v = this.parseExpr();
      const close = this.consume();
      if (!close || close.kind !== 'rparen') throw new Error('Expected )');
      return v;
    }
    throw new Error(`Unexpected token "${t.value}"`);
  }

  finished(): boolean { return this.i >= this.tokens.length; }
}

/**
 * Evaluate `formula` with `values` (keyed by reference name).
 * Returns `{ ok: false }` if the formula is syntactically broken or refers
 * to non-numeric data; the caller decides whether to surface this as "" to
 * the recipient or as an error to the sender (in the builder).
 */
export function evaluateFormula(
  formula: string,
  values: Record<string, string>,
): FormulaResult {
  const trimmed = formula.trim();
  if (!trimmed) return { ok: false, error: { kind: 'parse', message: 'Empty formula' } };
  const toks = tokenize(trimmed);
  if (!Array.isArray(toks)) return { ok: false, error: toks };
  const parser = new Parser(toks, values);
  try {
    const result = parser.parseExpr();
    if (!parser.finished()) {
      return { ok: false, error: { kind: 'parse', message: 'Unexpected tokens after expression' } };
    }
    if (!Number.isFinite(result)) {
      return { ok: false, error: { kind: 'eval', message: 'Result is not finite (missing or non-numeric reference)' } };
    }
    return { ok: true, value: result };
  } catch (err) {
    return { ok: false, error: { kind: 'parse', message: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * Format a numeric formula result for stamping. Trims trailing zeros for
 * non-integer results so "100" renders as "100" not "100.0000000000001".
 */
export function formatFormulaValue(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n)) return String(n);
  return Number(n.toFixed(6)).toString();
}
