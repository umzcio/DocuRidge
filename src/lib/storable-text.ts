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
