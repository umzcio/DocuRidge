/**
 * Sender-written field validation patterns run against recipient input, so a
 * pattern that backtracks catastrophically (`^(a+)+$`) could stall the single
 * Node process. Patterns are screened when a sender saves them, and every
 * evaluation is time-bounded on the server (see pattern-server.ts) because
 * patterns stored before this check existed are never re-screened.
 *
 * The screen is a conservative star-height check: a group repeated by `*`,
 * `+` or `{n,m}` may not itself contain a repeat or an alternation, and
 * backreferences are refused. It has false positives (`([a-z]+\.)+` is
 * refused) but no false negatives for exponential backtracking. Polynomial
 * blow-ups such as `\d*\d*\d*x` pass it; the server-side time bound and the
 * value length cap handle those.
 *
 * Client-safe: no Node imports.
 */

export const MAX_FIELD_PATTERN_LENGTH = 200;
export const MAX_FIELD_VALUE_LENGTH = 10_000;

export type FieldPatternCheck = { ok: true } | { ok: false; reason: string };

interface GroupFrame {
  hasRepeat: boolean;
  hasAlternation: boolean;
}

const BOUNDED_QUANTIFIER = /^\{(\d+)(,(\d*))?\}/;

export function checkFieldPattern(pattern: string): FieldPatternCheck {
  if (pattern.length > MAX_FIELD_PATTERN_LENGTH) {
    return { ok: false, reason: `Pattern must be ${MAX_FIELD_PATTERN_LENGTH} characters or fewer.` };
  }
  try {
    new RegExp(pattern);
  } catch {
    return { ok: false, reason: 'Pattern is not a valid regular expression.' };
  }

  const stack: GroupFrame[] = [{ hasRepeat: false, hasAlternation: false }];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    let closedGroup: GroupFrame | null = null;

    if (ch === '\\') {
      const next = pattern[i + 1] ?? '';
      if (/[1-9]/.test(next) || (next === 'k' && pattern[i + 2] === '<')) {
        return { ok: false, reason: 'Pattern may not use backreferences.' };
      }
      i += 2;
    } else if (ch === '[') {
      i += 1;
      if (pattern[i] === '^') i += 1;
      if (pattern[i] === ']') i += 1;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      i += 1;
    } else if (ch === '(') {
      stack.push({ hasRepeat: false, hasAlternation: false });
      i += 1;
      if (pattern[i] === '?') {
        const named = /^\?<[A-Za-z_$][\w$]*>/.exec(pattern.slice(i));
        i += named ? named[0].length : pattern[i + 1] === '<' ? 3 : 2;
      }
      continue;
    } else if (ch === ')') {
      closedGroup = stack.pop()!;
      i += 1;
    } else if (ch === '|') {
      stack[stack.length - 1]!.hasAlternation = true;
      i += 1;
      continue;
    } else {
      i += 1;
    }

    const { repeats, length } = readQuantifier(pattern, i);
    i += length;
    const frame = stack[stack.length - 1]!;
    if (closedGroup) {
      if (repeats && closedGroup.hasRepeat) {
        return { ok: false, reason: 'Pattern may not repeat a group that contains a repeat (nested quantifiers).' };
      }
      if (repeats && closedGroup.hasAlternation) {
        return { ok: false, reason: 'Pattern may not repeat a group that contains alternation (|).' };
      }
      frame.hasRepeat ||= closedGroup.hasRepeat;
      frame.hasAlternation ||= closedGroup.hasAlternation;
    }
    frame.hasRepeat ||= repeats;
  }
  return { ok: true };
}

export function isSafeFieldPattern(pattern: string): boolean {
  return checkFieldPattern(pattern).ok;
}

function readQuantifier(pattern: string, at: number): { repeats: boolean; length: number } {
  const ch = pattern[at];
  let repeats = false;
  let length = 0;
  if (ch === '*' || ch === '+') {
    repeats = true;
    length = 1;
  } else if (ch === '?') {
    length = 1;
  } else if (ch === '{') {
    const m = BOUNDED_QUANTIFIER.exec(pattern.slice(at));
    if (m) {
      const min = Number(m[1]);
      const max = m[2] ? (m[3] ? Number(m[3]) : Infinity) : min;
      repeats = max > 1;
      length = m[0].length;
    }
  }
  if (length > 0 && pattern[at + length] === '?') length += 1;
  return { repeats, length };
}
