import { it, vi, expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { writeFile } from 'node:fs/promises';
vi.mock('server-only', () => ({}));
import { suggestPageFields } from './provider';
import { detectSigningLines, refineSignaturePlacement } from './signature-placement';

// Explicit opt-in: contacts a local model using generated documents only.
it.skipIf(!process.env.DOCURIDGE_AI_LIVE_TEST)('compares signature placement on synthetic PDF layouts', async () => {
  const models = (process.env.DOCURIDGE_AI_TEST_MODELS || 'qwen3.8:27b,qwen3-vl:32b').split(',');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const expected: { x: number; y: number; w: number }[][] = [];
  for (const layout of ['below', 'above', 'inline']) {
    const page = pdf.addPage([600, 800]);
    page.drawText(`Sample agreement: ${layout} labels`, { x: 40, y: 740, font, size: 18 });
    page.drawText('Please complete the signing areas below.', { x: 40, y: 700, font, size: 11 });
    const lines = layout === 'inline' ? [{ x: 130, y: 550, w: 230 }, { x: 130, y: 330, w: 230 }] : [{ x: 45, y: 550, w: 235 }, { x: 325, y: 550, w: 230 }];
    lines.forEach((line, i) => {
      page.drawLine({ start: { x: line.x, y: line.y }, end: { x: line.x + line.w, y: line.y }, thickness: 0.8 });
      const label = i === 0 ? 'Employee signature' : 'Witness signature';
      page.drawText(layout === 'inline' ? 'Signature:' : label, { x: layout === 'inline' ? 45 : line.x, y: line.y + (layout === 'below' ? -16 : layout === 'above' ? 42 : 4), font, size: 11 });
      page.drawLine({ start: { x: line.x, y: line.y - 100 }, end: { x: line.x + 130, y: line.y - 100 }, thickness: .8 });
      page.drawText('Date', { x: line.x, y: line.y - 116, font, size: 11 });
    });
    expected.push(lines.map(l => ({ x: l.x / 600, y: 1 - l.y / 800, w: l.w / 600 })));
  }
  const bytes = await pdf.save();
  await writeFile('/tmp/docuridge-placement-fixture.pdf', bytes);
  const doc = await getDocument({ data: bytes, standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` }).promise;
  const reports = [];
  try {
    for (const model of models) {
      vi.stubEnv('DOCURIDGE_AI_BASE_URL', 'http://127.0.0.1:11434/v1');
      vi.stubEnv('DOCURIDGE_AI_MODEL', model);
      vi.stubEnv('DOCURIDGE_AI_API_KEY', '');
      for (let p = 1; p <= doc.numPages; p++) {
        const source = await doc.getPage(p);
        const base = source.getViewport({ scale: 1 });
        const viewport = source.getViewport({ scale: 2 });
        const canvas = createCanvas(viewport.width, viewport.height);
        const ctx = canvas.getContext('2d');
        await source.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
        const content = await source.getTextContent();
        const text = content.items.filter(item => 'str' in item).map(item => {
          if (!('str' in item)) return '';
          const [x, y] = base.convertToViewportPoint(item.transform[4]!, item.transform[5]!);
          return `[x=${(x! / base.width).toFixed(3)},y=${(y! / base.height).toFixed(3)}] ${item.str}`;
        }).join('\n');
        const start = Date.now();
        try {
          const fields = await suggestPageFields({ image: canvas.toDataURL('image/jpeg', .8), text, page: p });
          const lines = detectSigningLines(ctx.getImageData(0, 0, canvas.width, canvas.height));
          const refined = refineSignaturePlacement(fields, lines);
          const errors = (suggestions: typeof fields) => expected[p - 1]!.map(line => Math.min(...suggestions.filter(f => f.type === 'SIGNATURE').map(f => Math.hypot((f.x + f.w / 2 - line.x - line.w / 2) * 600, (f.y + f.h - line.y) * 800))));
          reports.push({ model, page: p, elapsedMs: Date.now() - start, fields, refined, errorsPoints: errors(fields), refinedErrorsPoints: errors(refined) });
          for (const [color, suggestions] of [['#cc3333', fields], ['#0066dd', refined]] as const) {
            ctx.strokeStyle = color; ctx.lineWidth = 2;
            for (const f of suggestions.filter(f => f.type === 'SIGNATURE')) ctx.strokeRect(f.x * canvas.width, f.y * canvas.height, f.w * canvas.width, f.h * canvas.height);
          }
          await writeFile(`/tmp/docuridge-placement-${model.replaceAll(':', '-')}-${p}.png`, canvas.toBuffer('image/png'));
        } catch (error) { reports.push({ model, page: p, error: String(error), elapsedMs: Date.now() - start }); }
        process.stdout.write(`${JSON.stringify(reports.at(-1))}\n`);
      }
    }
    await writeFile('/tmp/docuridge-placement-comparison.json', JSON.stringify(reports, null, 2));
    expect(reports.every(r => !('error' in r))).toBe(true);
  } finally { vi.unstubAllEnvs(); await doc.destroy(); }
}, 360_000);
