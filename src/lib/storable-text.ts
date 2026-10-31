/**
 * Postgres `text` rejects NUL bytes and `jsonb` rejects the `\u0000` escape,
 * so a single NUL in user input fails the whole write. Lone UTF-16 surrogates
 * are silently replaced with U+FFFD on the way into the database, which would
 * make a stored audit row hash differently from the value we signed.
 */
const NUL = /\u0000/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const HAS_LONE_SURROGATE = new RegExp(LONE_SURROGATE.source);
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const UNSUPPORTED_TEXT_MESSAGE = 'Text contains unsupported characters.';

/** Boundary check for free text: no control characters other than tab/newline, no lone surrogates. */
export function isStorableText(value: string): boolean {
  return !DISALLOWED_CONTROL.test(value) && !HAS_LONE_SURROGATE.test(value);
}

/**
 * Characters a sealed page cannot draw (its WinAnsi fonts encode none of
 * them): C0 and C1 controls, DEL, and the Unicode line and paragraph
 * separators. A multi-line value may keep LF.
 */
const ANY_CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const CONTROL_BUT_LF = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/;

/** Boundary check for single-line text the seal draws: {@link isStorableText}, and no tab, line break or C1 control. */
export function isSingleLineText(value: string): boolean {
  return !ANY_CONTROL.test(value) && !HAS_LONE_SURROGATE.test(value);
}

/**
 * A submitted value the seal will draw, normalised: tab becomes a space and,
 * when `multiline`, CRLF and CR become LF. Null when any other control
 * character (C0, DEL, C1, U+2028/U+2029) or a lone surrogate remains, which
 * the caller refuses with UNSUPPORTED_TEXT_MESSAGE.
 */
export function toDrawableText(value: string, opts: { multiline?: boolean } = {}): string | null {
  let text = value.replace(/\t/g, ' ');
  if (opts.multiline) text = text.replace(/\r\n?/g, '\n');
  if ((opts.multiline ? CONTROL_BUT_LF : ANY_CONTROL).test(text) || HAS_LONE_SURROGATE.test(text)) return null;
  return text;
}

/** `value` on one line: every control character, line break and separator becomes `replacement`. */
export function toSingleLineText(value: string, replacement: string): string {
  return value.replace(new RegExp(ANY_CONTROL.source, 'g'), replacement);
}

export function toStorableText(value: string): string {
  return value.replace(NUL, '').replace(LONE_SURROGATE, '\uFFFD');
}

/** Recursively applies {@link toStorableText} to every string inside a JSON-like value. */
export function toStorableJson(value: unknown): unknown {
  if (typeof value === 'string') return toStorableText(value);
  if (Array.isArray(value)) return value.map(toStorableJson);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[toStorableText(k)] = toStorableJson(v);
    return out;
  }
  return value;
}
