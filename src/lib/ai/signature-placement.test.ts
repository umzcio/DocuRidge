import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { detectSigningLines, refineSignaturePlacement } from './signature-placement';
import { fieldSuggestionSchema, type FieldSuggestion } from './field-suggestions';

const signature: FieldSuggestion = { type: 'SIGNATURE', page: 1, x: .11, y: .475, w: .28, h: .04, label: 'Signature', confidence: .9 };
function raster(draw: (ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>) => void) {
  const canvas = createCanvas(1000, 1000);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1000, 1000); ctx.fillStyle = 'black';
  draw(ctx);
  return ctx.getImageData(0, 0, 1000, 1000);
}

describe('signature placement', () => {
  it.each([.5, .512])('moves a signature whose top starts at/below the line (y=%s) above it', y => {
    const field = { ...signature, y, h: .06 };
    const lines = detectSigningLines(raster(ctx => {
      ctx.fillRect(100, 500, 300, 2);
      ctx.font = '18px sans-serif'; ctx.fillText('Employee signature', 100, 525);
    }));
    const [result] = refineSignaturePlacement([field], lines);
    expect(result!.y).toBeLessThan(.5);
    expect(result!.y + result!.h).toBeCloseTo(.501, 3);
  });
  it('does not pull a signature up to a distant rule above its box', () => {
    const field = { ...signature, y: .54, h: .06 };
    expect(refineSignaturePlacement([field], [{ x: .1, y: .5, w: .3, clearance: .07 }])).toEqual([field]);
  });
  it('prefers an already aligned bottom edge to the top border of a boxed field', () => {
    const field = { ...signature, y: .5, h: .04 };
    const lines = [{ x: .1, y: .5, w: .3, clearance: .07 }, { x: .1, y: .54, w: .3, clearance: .035 }];
    const [result] = refineSignaturePlacement([field], lines);
    expect(result!.y + result!.h).toBeCloseTo(.54);
  });
  it('aligns a nearby signature to the signing line with its box above the baseline', () => {
    const lines = detectSigningLines(raster(ctx => ctx.fillRect(100, 500, 300, 2)));
    const [result] = refineSignaturePlacement([signature], lines);
    expect(result!.x).toBeCloseTo(.1, 3);
    expect(result!.w).toBeCloseTo(.3, 3);
    expect(result!.y + result!.h).toBeCloseTo(.501, 3);
    expect(result!.h).toBeCloseTo(.04);
    expect(fieldSuggestionSchema.safeParse(result).success).toBe(true);
  });
  it('preserves signatures without a nearby clear line and does not move other field types', () => {
    const lines = detectSigningLines(raster(ctx => ctx.fillRect(100, 800, 300, 2)));
    expect(refineSignaturePlacement([signature], lines)).toEqual([signature]);
    const text = { ...signature, type: 'TEXT' as const };
    expect(refineSignaturePlacement([text], [{ x: .1, y: .5, w: .3, clearance: .07 }])).toEqual([text]);
  });
  it('does not mistake text, thick dividers, or full-page rules for signing lines', () => {
    const lines = detectSigningLines(raster(ctx => {
      ctx.font = '18px sans-serif'; ctx.fillText('Signature of the employee', 100, 500);
      ctx.fillRect(100, 600, 300, 15);
      ctx.fillRect(0, 800, 1000, 1);
    }));
    expect(lines).toEqual([]);
  });
  it('respects labels above the line and does not place a box over existing writing', () => {
    const lines = detectSigningLines(raster(ctx => {
      ctx.fillRect(100, 500, 300, 2);
      ctx.font = '20px sans-serif'; ctx.fillText('Signature', 100, 464);
    }));
    const [result] = refineSignaturePlacement([{ ...signature, h: .06, y: .455 }], lines);
    expect(result!.y).toBeGreaterThan(.464);
    expect(result!.y + result!.h).toBeCloseTo(.501, 3);
    const filled = detectSigningLines(raster(ctx => {
      ctx.fillRect(100, 500, 300, 2);
      ctx.font = '30px sans-serif'; ctx.fillText('Already signed', 110, 498);
    }));
    expect(refineSignaturePlacement([signature], filled)).toEqual([signature]);
  });
  it('leaves equally plausible lines unchanged', () => {
    const lines = [{ x: .1, y: .505, w: .3, clearance: .07 }, { x: .1, y: .525, w: .3, clearance: .07 }];
    expect(refineSignaturePlacement([signature], lines)).toEqual([signature]);
  });
  it('keeps adjacent signers on separate lines and never snaps two fields onto one line', () => {
    const lines = [{ x: .1, y: .5, w: .3, clearance: .07 }, { x: .6, y: .5, w: .3, clearance: .07 }];
    const right = { ...signature, x: .61, label: 'Witness signature' };
    const result = refineSignaturePlacement([signature, right, { ...signature, label: 'Duplicate' }], lines);
    expect(result[0]!.x).toBe(.1); expect(result[1]!.x).toBe(.6);
    expect(result[2]).toEqual({ ...signature, label: 'Duplicate' });
  });
  it('handles boxed fields and short initials lines', () => {
    const lines = detectSigningLines(raster(ctx => {
      ctx.strokeRect(100, 450, 300, 50);
      ctx.fillRect(600, 500, 80, 2);
    }));
    const initial = { ...signature, type: 'INITIALS' as const, x: .6, w: .08 };
    const results = refineSignaturePlacement([signature, initial], lines);
    expect(results[0]!.y + results[0]!.h).toBeCloseTo(.5, 2);
    expect(results[1]!.y + results[1]!.h).toBeCloseTo(.501, 3);
  });
  it('does not redirect a duplicate onto its second-best line when the best is already used', () => {
    const field = { ...signature, y: .46 };
    const duplicate = { ...field, label: 'Duplicate' };
    const lines = [{ x: .1, y: .5, w: .3, clearance: .07 }, { x: .1, y: .53, w: .3, clearance: .028 }];
    expect(refineSignaturePlacement([field, duplicate], lines)[1]).toEqual(duplicate);
  });
  it('does not introduce overlap with suggested or already placed fields', () => {
    const field = { ...signature, y: .44 };
    const date = { ...signature, type: 'DATE' as const, y: .49, h: .02 };
    const lines = [{ x: .1, y: .51, w: .3, clearance: .07 }];
    expect(refineSignaturePlacement([field, date], lines)[0]).toEqual(field);
    expect(refineSignaturePlacement([field], lines, [date])[0]).toEqual(field);
    expect(refineSignaturePlacement([field], lines, [{ ...date, page: 2 }])[0]!.y).toBeCloseTo(.47);
  });
});
