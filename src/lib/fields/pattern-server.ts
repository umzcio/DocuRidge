import { Script, createContext } from 'node:vm';

export const FIELD_PATTERN_TIMEOUT_MS = 50;

export type FieldPatternResult = 'match' | 'mismatch' | 'invalid' | 'timeout';

const evaluate = new Script('pattern.test(value)');

/**
 * Run a sender-written pattern against a submitted value with a hard time
 * budget. V8's backtracking engine honours the vm watchdog, so a
 * catastrophic pattern is interrupted after `timeoutMs` instead of blocking
 * the event loop for every other request.
 */
export function testFieldPattern(
  pattern: string,
  value: string,
  timeoutMs = FIELD_PATTERN_TIMEOUT_MS,
): FieldPatternResult {
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern);
  } catch {
    return 'invalid';
  }
  try {
    const matched = evaluate.runInContext(createContext({ pattern: compiled, value }), { timeout: timeoutMs });
    return matched ? 'match' : 'mismatch';
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return 'timeout';
    throw err;
  }
}
