/**
 * Ceilings on how many fields one envelope carries. Sealing stamps every
 * field inline in the last signer's request, so an envelope with an unbounded
 * number of fields is unbounded seal work. Enforced wherever fields enter an
 * envelope (builder action, `addField`, template instantiation) and again at
 * send, which also covers rows inserted by any other path.
 *
 * Leaf module: reads its caps from `process.env` directly (as
 * `src/lib/signing/signature-image.ts` does) so it works in tests and scripts
 * without a fully validated app env.
 */

/** Default ceiling on fields in one envelope. */
export const DEFAULT_ENVELOPE_MAX_FIELDS = 2000;
/** Default ceiling on fields on one page of one document. */
export const DEFAULT_ENVELOPE_MAX_FIELDS_PER_PAGE = 200;

export interface FieldCaps {
  perEnvelope: number;
  perPage: number;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = typeof process === 'undefined' ? undefined : process.env?.[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getFieldCaps(): FieldCaps {
  return {
    perEnvelope: positiveIntFromEnv('ENVELOPE_MAX_FIELDS', DEFAULT_ENVELOPE_MAX_FIELDS),
    perPage: positiveIntFromEnv('ENVELOPE_MAX_FIELDS_PER_PAGE', DEFAULT_ENVELOPE_MAX_FIELDS_PER_PAGE),
  };
}

/** An envelope has more fields than the configured caps allow. */
export class FieldCapError extends Error {
  readonly code = 'field_cap_exceeded';
  constructor(message: string) {
    super(message);
    this.name = 'FieldCapError';
  }
}

function envelopeMessage(caps: FieldCaps): string {
  return `An envelope can have at most ${caps.perEnvelope} fields.`;
}

function pageMessage(caps: FieldCaps): string {
  return `A page can have at most ${caps.perPage} fields.`;
}

/**
 * Refuse a field set over the per-envelope or per-page cap. A page is
 * identified by its document and page number together.
 */
export function assertFieldCaps(
  fields: ReadonlyArray<{ document: string | number; page: number }>,
  caps: FieldCaps = getFieldCaps(),
): void {
  if (fields.length > caps.perEnvelope) throw new FieldCapError(envelopeMessage(caps));
  const perPage = new Map<string, number>();
  for (const f of fields) {
    const key = `${String(f.document).length}:${String(f.document)}:${f.page}`;
    const n = (perPage.get(key) ?? 0) + 1;
    if (n > caps.perPage) throw new FieldCapError(pageMessage(caps));
    perPage.set(key, n);
  }
}

/**
 * Refuse adding one more field to an envelope that already holds
 * `envelopeCount` fields, `pageCount` of them on the target page.
 */
export function assertCanAddField(
  counts: { envelopeCount: number; pageCount: number },
  caps: FieldCaps = getFieldCaps(),
): void {
  if (counts.envelopeCount + 1 > caps.perEnvelope) throw new FieldCapError(envelopeMessage(caps));
  if (counts.pageCount + 1 > caps.perPage) throw new FieldCapError(pageMessage(caps));
}
