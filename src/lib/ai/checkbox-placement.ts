import type { FieldSuggestion } from './field-suggestions';
export type CheckboxBox = { x: number; y: number; w: number; h: number };
type FieldBox = CheckboxBox & { page: number; type: string };
type PagePixels = { width: number; height: number; data: Uint8ClampedArray };
/** Find small, empty, four-sided squares in the rendered page, not their labels. */
export function detectCheckboxes({ width, height, data }: PagePixels): CheckboxBox[] {
  const size = width * height;
  if (!size || data.length !== size * 4) return [];
  const ink = new Uint8Array(size);
  for (let i = 0; i < size; i++) ink[i] = data[i * 4 + 3]! > 128 && data[i * 4]! + data[i * 4 + 1]! + data[i * 4 + 2]! < 420 ? 1 : 0;
  const queue = new Int32Array(size);
  const boxes: CheckboxBox[] = [];
  for (let start = 0; start < size; start++) {
    if (ink[start] !== 1) continue;
    let head = 0, tail = 1;
    queue[0] = start; ink[start] = 2;
    let left = start % width, right = left, top = Math.floor(start / width), bottom = top;
    const visit = (i: number) => { if (ink[i] === 1) { ink[i] = 2; queue[tail++] = i; } };
    while (head < tail) {
      const i = queue[head++]!, x = i % width, y = Math.floor(i / width);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      if (x > 0) visit(i - 1); if (x < width - 1) visit(i + 1);
      if (y > 0) visit(i - width); if (y < height - 1) visit(i + width);
    }
    const w = right - left + 1, h = bottom - top + 1;
    if (w < Math.max(6, width * .005) || h < Math.max(6, height * .005) ||
        w > width * .045 || h > height * .045 || w / h < .8 || w / h > 1.25) continue;
    const band = Math.max(1, Math.floor(Math.min(w, h) * .1));
    let north = 0, south = 0, west = 0, east = 0, inner = 0, innerSize = 0;
    for (let x = left; x <= right; x++) {
      let a = false, b = false;
      for (let d = 0; d < band; d++) { a ||= !!ink[(top + d) * width + x]; b ||= !!ink[(bottom - d) * width + x]; }
      if (a) north++; if (b) south++;
    }
    for (let y = top; y <= bottom; y++) {
      let a = false, b = false;
      for (let d = 0; d < band; d++) { a ||= !!ink[y * width + left + d]; b ||= !!ink[y * width + right - d]; }
      if (a) west++; if (b) east++;
      for (let x = left + band + 1; x < right - band; x++) if (y > top + band && y < bottom - band) { innerSize++; if (ink[y * width + x]) inner++; }
    }
    if (Math.min(north / w, south / w, west / h, east / h) < .8 || !innerSize || inner / innerSize > .05) continue;
    boxes.push({ x: left / width, y: top / height, w: w / width, h: h / height });
    if (boxes.length > 200) return [];
  }
  return boxes;
}

function intersection(a: FieldBox, b: FieldBox) {
  return a.page !== b.page ? 0 : Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
}

/** Match only nearby, unambiguous checkbox predictions, preserving other fields. */
export function refineCheckboxPlacement<T extends FieldSuggestion>(fields: readonly T[], boxes: readonly CheckboxBox[], existing: readonly FieldBox[] = []): T[] {
  const candidates = fields.map(field => {
    if (field.type !== 'CHECKBOX') return [];
    return boxes.flatMap((box, index) => {
      const dx = Math.abs(field.x + field.w / 2 - box.x - box.w / 2);
      const dy = Math.abs(field.y + field.h / 2 - box.y - box.h / 2);
      const score = Math.hypot(dx / box.w, dy / box.h);
      if (dx > .035 || dy > .025 || score > 3 || field.w > box.w * 4 || field.h > box.h * 4) return [];
      return [{ index, box, score }];
    }).sort((a, b) => a.score - b.score);
  });
  const choose = (matches: typeof candidates[number]) => !matches[0] || (matches[1] && matches[1].score - matches[0].score < .35) ? undefined : matches[0];
  const primary = candidates.map(choose);
  const strong = primary.map((choice, i) => choice && !primary.some((other, j) => i !== j && fields[j]!.page === fields[i]!.page && other?.index === choice.index) ? choice : undefined);
  const choices = primary.map((choice, i) => {
    if (choice) return strong[i]; // Conflicting clear matches never use a runner-up.
    // A clearly matched neighboring option can disambiguate a between-row estimate.
    return choose(candidates[i]!.filter(candidate => !strong.some((other, j) => fields[j]!.page === fields[i]!.page && other?.index === candidate.index)));
  });
  const result = fields.map((field, i) => {
    const choice = choices[i];
    // Do not resolve competing predictions by moving one to a different option.
    if (!choice || choices.some((other, j) => i !== j && fields[j]!.page === field.page && other?.index === choice.index)) return field;
    return { ...field, ...choice.box };
  });
  // Check proposed positions together: an inaccurate neighbor's original box
  // must not block both options from moving to their distinct printed squares.
  // Recheck after rejections so no remaining move collides with a restored box.
  let changed = true;
  while (changed) {
    changed = false;
    const rejected: number[] = [];
    for (let i = 0; i < result.length; i++) {
      if (result[i] === fields[i]) continue;
      const refined = result[i]!, original = fields[i]!;
      const collides = (other: FieldBox, before: FieldBox) => {
        const area = intersection(refined, other);
        // Let the caller's final deduplication remove an already placed checkbox.
        if (other.type === 'CHECKBOX' && area / (refined.w * refined.h + other.w * other.h - area) >= .5) return false;
        return area > intersection(original, before) + .000001;
      };
      if (existing.some(other => collides(other, other)) || result.some((other, j) => j !== i && collides(other, fields[j]!))) rejected.push(i);
    }
    for (const i of rejected) { result[i] = fields[i]!; changed = true; }
  }
  return result;
}
