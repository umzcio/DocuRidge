import { it, expect, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
vi.mock('server-only', () => ({}));
import { suggestPageFields } from './provider';
import { detectCheckboxes, refineCheckboxPlacement } from './checkbox-placement';
import { detectSigningLines, refineSignaturePlacement } from './signature-placement';

// Explicitly supplied local PDF only; no documents are bundled with the tests.
it.skipIf(!process.env.DOCURIDGE_AI_CHECKBOX_PDF)('aligns the seven parking-form checkboxes using local Qwen', async () => {
  vi.stubEnv('DOCURIDGE_AI_BASE_URL', 'http://127.0.0.1:11434/v1');
  vi.stubEnv('DOCURIDGE_AI_MODEL', 'qwen3.8:27b'); vi.stubEnv('DOCURIDGE_AI_API_KEY', '');
  const pdf = await getDocument({ data: new Uint8Array(await readFile(process.env.DOCURIDGE_AI_CHECKBOX_PDF!)), standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` }).promise;
  try {
    const page = await pdf.getPage(1), base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, 1600 / Math.max(base.width, base.height)) });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)), ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
    const content = await page.getTextContent();
    const text = content.items.filter(i => 'str' in i).map(i => {
      if (!('str' in i)) return '';
      const [x, y] = base.convertToViewportPoint(i.transform[4]!, i.transform[5]!);
      return `[x=${(x! / base.width).toFixed(3)},y=${(y! / base.height).toFixed(3)}] ${i.str}`;
    }).join('\n').slice(0, 24000);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const boxes = detectCheckboxes(pixels);
    expect(boxes).toHaveLength(7);
    const start = Date.now();
    const raw = await suggestPageFields({ image: canvas.toDataURL('image/jpeg', .8), text, page: 1 });
    const refined = refineCheckboxPlacement(refineSignaturePlacement(raw, detectSigningLines(pixels)), boxes);
    await writeFile('/tmp/docuridge-parking-fields.json', JSON.stringify({ raw, refined, boxes }, null, 2));
    const checks = refined.filter(f => f.type === 'CHECKBOX');
    process.stdout.write(JSON.stringify({ fields: raw.length, checkboxes: checks.length, elapsedMs: Date.now() - start }) + '\n');
    expect(checks).toHaveLength(7);
    for (const box of boxes) expect(checks.filter(f => f.x === box.x && f.y === box.y && f.w === box.w && f.h === box.h)).toHaveLength(1);
    ctx.strokeStyle = '#0066dd'; ctx.lineWidth = 2;
    for (const f of checks) ctx.strokeRect(f.x * canvas.width, f.y * canvas.height, f.w * canvas.width, f.h * canvas.height);
    await writeFile('/tmp/docuridge-parking-refined.png', canvas.toBuffer('image/png'));
  } finally { vi.unstubAllEnvs(); await pdf.destroy(); }
}, 60000);
