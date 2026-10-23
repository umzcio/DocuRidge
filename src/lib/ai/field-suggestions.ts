import { z } from 'zod';

/** Shared with the review dialog; this module never reads server configuration. */
export const SUGGESTION_TYPES = ['SIGNATURE', 'INITIALS', 'DATE', 'TEXT', 'NUMBER', 'CHECKBOX', 'NAME', 'EMAIL', 'PHONE', 'ADDRESS', 'COMPANY', 'JOB_TITLE'] as const;
export type SuggestionType = (typeof SUGGESTION_TYPES)[number];
export const MAX_PAGE_TEXT_CHARS = 24_000;
export const MAX_PAGE_REQUEST_BYTES = 6 * 1024 * 1024;
export const MAX_SUGGESTIONS_PER_PAGE = 80;
const MAX_IMAGE_BASE64_CHARS = 4 * Math.ceil((4 * 1024 * 1024) / 3);

const unit = z.number().finite().min(0).max(1);
export const fieldSuggestionSchema = z.object({
  type: z.enum(SUGGESTION_TYPES),
  page: z.number().int().min(1).max(2_000),
  x: unit, y: unit,
  w: z.number().finite().min(0.005).max(1),
  h: z.number().finite().min(0.005).max(1),
  label: z.string().trim().max(120),
  confidence: unit,
}).strict().refine((field) => field.x + field.w <= 1 && field.y + field.h <= 1, 'Field must fit inside the page')
  .transform((field) => ({ ...field, label: field.label || field.type[0] + field.type.slice(1).toLowerCase().replaceAll('_', ' ') }));
export type FieldSuggestion = z.infer<typeof fieldSuggestionSchema>;

export const pageSuggestionRequestSchema = z.object({
  image: z.string().max(MAX_IMAGE_BASE64_CHARS + 23).regex(/^data:image\/jpeg;base64,\/9j\/(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  text: z.string().max(MAX_PAGE_TEXT_CHARS),
  page: z.number().int().min(1).max(2_000),
}).strict();
export type PageSuggestionRequest = z.infer<typeof pageSuggestionRequestSchema>;
export const pageSuggestionsSchema = z.object({ suggestions: z.array(fieldSuggestionSchema).max(MAX_SUGGESTIONS_PER_PAGE) }).strict();

type FieldBox = { type: string; page: number; x: number; y: number; w: number; h: number };
function overlaps(a: FieldBox, b: FieldBox): boolean {
  if (a.page !== b.page || a.type !== b.type) return false;
  const intersection = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return intersection / (a.w * a.h + b.w * b.h - intersection) >= 0.5;
}

/** Keep the first candidate when same-type boxes overlap by at least 50% IoU. */
export function filterDuplicateSuggestions<T extends FieldBox>(candidates: readonly T[], existing: readonly FieldBox[]): T[] {
  const accepted: T[] = [];
  for (const candidate of candidates) {
    if (!existing.some((field) => overlaps(candidate, field)) && !accepted.some((field) => overlaps(candidate, field))) accepted.push(candidate);
  }
  return accepted;
}
