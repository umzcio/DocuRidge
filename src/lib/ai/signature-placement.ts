import type { FieldSuggestion } from './field-suggestions';

export type SigningLine = { x: number; y: number; w: number; clearance: number };
type PagePixels = { width: number; height: number; data: Uint8ClampedArray };
type FieldBox = Pick<FieldSuggestion, 'page' | 'x' | 'y' | 'w' | 'h'>;
function intersection(a: FieldBox, b: FieldBox): number {
  if (a.page !== b.page) return 0;
  return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
}

/** Find thin horizontal rules in the exact upright image shown to the model.
 * Works on scanned and vector PDFs without interpreting PDF drawing operators.
 */
export function detectSigningLines({ width, height, data }: PagePixels): SigningLine[] {
  if (!width || !height || data.length !== width * height * 4) return [];
  const dark = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return data[i + 3]! > 128 && (data[i]! + data[i + 1]! + data[i + 2]!) < 420;
  };
  type Rule = { left: number; right: number; top: number; bottom: number };
  const rules: Rule[] = [];
  let previous: Rule[] = [];
  const minimumWidth = Math.max(24, width * .075);
  for (let y = 0; y < height; y++) {
    const current: Rule[] = [];
    let start = -1, last = -1, count = 0;
    const finish = () => {
      const span = last - start + 1;
      if (start >= 0 && span >= minimumWidth && span <= width * .85 && count / span >= .9) {
        const existing = previous.find(r => Math.abs(r.left - start) <= 2 && Math.abs(r.right - last) <= 2);
        if (existing) { existing.bottom = y; current.push(existing); }
        else { const rule = { left: start, right: last, top: y, bottom: y }; rules.push(rule); current.push(rule); }
      }
      start = -1; count = 0;
    };
    for (let x = 0; x < width; x++) {
      if (dark(x, y)) { if (start < 0) start = x; last = x; count++; }
      else if (start >= 0 && x - last > 2) finish();
    }
    finish(); previous = current;
    // Very densely ruled images are not safe candidates for automatic snapping.
    if (rules.length > 2_000) return [];
  }
  const lines: SigningLine[] = [];
  for (const rule of rules) {
    if (rule.bottom - rule.top + 1 > Math.max(3, height * .004)) continue;
    const span = rule.right - rule.left + 1;
    const inset = Math.max(3, Math.ceil(span * .015));
    let clearTop = rule.top - 1;
    for (let y = rule.top - 2; y >= Math.max(0, rule.top - height * .08); y--) {
      let ink = 0;
      for (let x = rule.left + inset; x <= rule.right - inset; x++) if (dark(x, y)) ink++;
      if (ink > Math.max(2, span * .015)) break;
      clearTop = y;
    }
    const baseline = (rule.top + rule.bottom + 1) / 2;
    const clearance = Math.max(0, baseline - clearTop - 2) / height;
    if (clearance >= .02) lines.push({ x: rule.left / width, y: baseline / height, w: span / width, clearance });
    if (lines.length > 200) return [];
  }
  return lines;
}

/** Refine signing fields only when a unique nearby line supports the model's box.
 * Never invent fields or move suggestions to a distant/occupied signing area.
 */
export function refineSignaturePlacement<T extends FieldSuggestion>(fields: readonly T[], lines: readonly SigningLine[], existing: readonly FieldBox[] = []): T[] {
  const used = new Set<number>();
  const result = [...fields];
  return fields.map((field, fieldIndex) => {
    if (field.type !== 'SIGNATURE' && field.type !== 'INITIALS') return field;
    const matches = lines.flatMap((line, index) => {
      const overlap = Math.max(0, Math.min(field.x + field.w, line.x + line.w) - Math.max(field.x, line.x));
      const centerDelta = Math.abs(field.x + field.w / 2 - line.x - line.w / 2);
      const bottomDelta = Math.abs(field.y + field.h - line.y);
      const bottomMatches = bottomDelta <= Math.min(.045, Math.max(.025, field.h * .8));
      // Models sometimes use the signing line/label as the TOP of the box.
      // Recognize that local reversal, but prefer a matching bottom edge (for
      // example the lower border of an actual rectangular signing area).
      const topDelta = Math.abs(field.y - line.y);
      const topMatches = field.y >= line.y - .002 && topDelta <= Math.min(.02, Math.max(.008, field.h * .4));
      if (line.clearance < .02 || line.w < field.w * .5 || line.w > field.w * 2 ||
          overlap / Math.min(field.w, line.w) < .7 || centerDelta > .05 || (!bottomMatches && !topMatches)) return [];
      const edgeDelta = Math.min(bottomMatches ? bottomDelta : Infinity, topMatches ? topDelta + .008 : Infinity);
      return [{ line, index, score: edgeDelta + centerDelta * .5 }];
    }).sort((a, b) => a.score - b.score);
    const best = matches[0];
    if (!best || used.has(best.index) || (matches[1] && matches[1].score - best.score < .006)) return field;
    const h = Math.min(Math.max(field.h, .025), .06, best.line.clearance, best.line.y);
    if (h < .02) return field;
    const refined = { ...field, x: best.line.x, y: best.line.y - h, w: best.line.w, h };
    const obstacles = [...existing, ...result.filter((_, i) => i !== fieldIndex)];
    if (obstacles.some(other => intersection(refined, other) > intersection(field, other) + .000001)) return field;
    used.add(best.index);
    result[fieldIndex] = refined;
    return refined;
  });
}
