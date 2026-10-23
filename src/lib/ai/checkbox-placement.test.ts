import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { detectCheckboxes, refineCheckboxPlacement } from './checkbox-placement';
import { filterDuplicateSuggestions, type FieldSuggestion } from './field-suggestions';

const field: FieldSuggestion = { type: 'CHECKBOX', page: 1, x: .18, y: .19, w: .03, h: .025, label: 'Cash', confidence: .9 };
const box = { x: .2, y: .2, w: .02, h: .02 };
function raster(draw: (ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>) => void, height = 1000) {
  const canvas = createCanvas(1000, height); const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1000, height); ctx.fillStyle = 'black'; ctx.strokeStyle = 'black'; ctx.lineWidth = 2;
  draw(ctx); return ctx.getImageData(0, 0, 1000, height);
}
describe('checkbox placement', () => {
  it('detects small empty squares but excludes circles, text, filled boxes and large rectangles', () => {
    const boxes = detectCheckboxes(raster(ctx => {
      ctx.strokeRect(201, 201, 18, 18);
      ctx.beginPath(); ctx.arc(310, 210, 10, 0, Math.PI * 2); ctx.stroke();
      ctx.font = '24px sans-serif'; ctx.fillText('O D 0 B', 400, 220);
      ctx.strokeRect(601, 201, 18, 18); ctx.fillRect(605, 205, 10, 10);
      ctx.strokeRect(100, 400, 300, 200);
    }));
    expect(boxes).toEqual([box]);
  });
  it('preserves physical square dimensions on a non-square page', () => {
    const [result] = detectCheckboxes(raster(ctx => ctx.strokeRect(201, 201, 18, 18), 1400));
    expect(result!.w).toBeCloseTo(.02); expect(result!.h).toBeCloseTo(20 / 1400);
  });
  it('moves and resizes an offset checkbox to the printed square', () => {
    expect(refineCheckboxPlacement([field], [box])).toEqual([{ ...field, ...box }]);
  });
  it('leaves distant or ambiguous boxes and other field types alone', () => {
    expect(refineCheckboxPlacement([field], [{ ...box, y: .8 }])).toEqual([field]);
    expect(refineCheckboxPlacement([{ ...field, x: .2, y: .2, w: .02, h: .02 }], [{ ...box, x: .18 }, { ...box, x: .22 }])).toEqual([{ ...field, x: .2, y: .2, w: .02, h: .02 }]);
    const text = { ...field, type: 'TEXT' as const };
    expect(refineCheckboxPlacement([text], [box])).toEqual([text]);
  });
  it('keeps horizontal and vertical options on separate squares', () => {
    const boxes = [box, { ...box, x: .3 }, { ...box, y: .25 }];
    const fields = [field, { ...field, x: .28 }, { ...field, y: .24 }];
    expect(refineCheckboxPlacement(fields, boxes).map(({ x, y, w, h }) => ({ x, y, w, h }))).toEqual(boxes);
  });
  it('does not let competing suggestions steal the same square or a second-choice square', () => {
    const other = { ...field, x: .19 };
    expect(refineCheckboxPlacement([field, other], [box, { ...box, x: .25 }])).toEqual([field, other]);
  });
  it('resolves an ambiguous vertical option when its neighbor has a clear separate match', () => {
    const boxes = [{ x: .88, y: .127, w: .016, h: .02 }, { x: .88, y: .166, w: .016, h: .02 }];
    const staff = { ...field, x: .875, y: .145, w: .025, h: .025, label: 'Staff' };
    const student = { ...staff, y: .17, label: 'Student' };
    expect(refineCheckboxPlacement([staff, student], boxes)).toEqual([{ ...staff, ...boxes[0] }, { ...student, ...boxes[1] }]);
  });
  it('does not introduce collisions with other fields', () => {
    const text = { ...field, type: 'TEXT' as const, x: .215, y: .2, w: .1 };
    expect(refineCheckboxPlacement([field, text], [box])[0]).toEqual(field);
    expect(refineCheckboxPlacement([field], [box], [text])[0]).toEqual(field);
    expect(refineCheckboxPlacement([field], [box], [{ ...text, page: 2 }])[0]).toEqual({ ...field, ...box });
  });
  it('allows duplicate filtering against an existing checkbox at the actual square', () => {
    const existing = { ...field, ...box };
    expect(filterDuplicateSuggestions(refineCheckboxPlacement([field], [box], [existing]), [existing])).toEqual([]);
  });
});
