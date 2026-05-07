/**
 * Anchor-tag scanner. Reads a PDF's text content and finds inline markers
 * like `{{sig:1}}` / `{{date:2}}` / `{{text:1}}` that the sender embeds in
 * their document template. The recipientOrder suffix (`:N`) maps the field
 * to the Nth recipient by signing order; `{{sig}}` (no suffix) maps to
 * recipient 1.
 *
 * Tags are rendered visibly in the PDF text by default — senders who don't
 * want them visible should set the marker text color to white in the source
 * document. The marker glyphs themselves are not stripped from the sealed
 * PDF; that is a (deliberate) sender responsibility, mirroring DocuSign's
 * behavior for anchor-tag autoplace.
 */
import * as pdfjs from 'pdfjs-dist';

/** Tag-prefix → FieldType. Order-suffix `:N` is parsed separately. */
const TYPE_MAP: Record<string, string> = {
  sig:     'SIGNATURE',
  ini:     'INITIALS',
  date:    'DATE',
  text:    'TEXT',
  num:     'NUMBER',
  check:   'CHECKBOX',
  name:    'NAME',
  email:   'EMAIL',
  title:   'JOB_TITLE',
  phone:   'PHONE',
  addr:    'ADDRESS',
  company: 'COMPANY',
};

/** Default field box dimensions (fractions of page) — must mirror builder. */
const DEFAULTS_BY_TYPE: Record<string, [number, number]> = {
  SIGNATURE:  [0.30, 0.06],
  INITIALS:   [0.10, 0.05],
  DATE:       [0.16, 0.035],
  TEXT:       [0.25, 0.035],
  NUMBER:     [0.16, 0.035],
  CHECKBOX:   [0.04, 0.04],
  NAME:       [0.25, 0.035],
  EMAIL:      [0.30, 0.035],
  JOB_TITLE:  [0.25, 0.035],
  PHONE:      [0.20, 0.035],
  ADDRESS:    [0.35, 0.05],
  COMPANY:    [0.25, 0.035],
};

export interface AnchorMatch {
  /** 1-based page index. */
  page: number;
  /** FieldType value as a string. */
  type: string;
  /** 1-based recipient signing order this tag is bound to. */
  recipientOrder: number;
  /** Top-left x, normalized to page width [0..1]. */
  x: number;
  /** Top-left y, normalized to page height [0..1] (top-down). */
  y: number;
  /** Field box width, normalized [0..1]. */
  w: number;
  /** Field box height, normalized [0..1]. */
  h: number;
  /** The literal marker text matched, e.g. "{{sig:1}}" — useful for telemetry. */
  marker: string;
}

const MARKER_RE = /\{\{(sig|ini|date|text|num|check|name|email|title|phone|addr|company)(?::(\d+))?\}\}/gi;

/**
 * Scan one PDF's text for anchor markers and return their type, recipient,
 * and on-page position. The `pdfjs` arg is passed in so the caller controls
 * worker setup (the builder loads pdfjs once and reuses it).
 */
export async function scanAnchorTags(
  arrayBuffer: ArrayBuffer,
): Promise<AnchorMatch[]> {
  const doc = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const matches: AnchorMatch[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const pageW = viewport.width;
      const pageH = viewport.height;
      const text = await page.getTextContent();
      for (const itemUnknown of text.items) {
        const item = itemUnknown as {
          str: string; transform: number[]; width?: number; height?: number;
        };
        const str = item.str ?? '';
        if (!str) continue;
        // Reset state — RegExp is shared across iterations otherwise.
        const re = new RegExp(MARKER_RE.source, 'gi');
        let m: RegExpExecArray | null;
        while ((m = re.exec(str)) !== null) {
          const tagPrefix = m[1]!.toLowerCase();
          const recipientOrder = m[2] ? Math.max(1, parseInt(m[2], 10)) : 1;
          const fieldType = TYPE_MAP[tagPrefix];
          if (!fieldType) continue;

          // pdfjs item.transform = [a, b, c, d, e, f]; e,f is the baseline
          // origin in PDF user-space (bottom-left coordinate system).
          const tx = item.transform;
          const itemX = tx[4]!;
          const baselineY = tx[5]!;
          const itemHeight = item.height ?? Math.abs(tx[3] ?? 12);
          const itemWidth = item.width ?? 0;

          // Estimate horizontal offset of the marker within the text item by
          // the marker's character offset / total length. This is approximate
          // for proportional fonts but accurate enough for autoplace; the
          // sender can nudge after detection.
          const totalLen = str.length || 1;
          const markerOffset = m.index / totalLen;
          const xPdf = itemX + markerOffset * itemWidth;

          // Convert PDF (bottom-up) y to top-down y.
          const yPdfTop = pageH - baselineY - itemHeight;

          const [defW, defH] = DEFAULTS_BY_TYPE[fieldType] ?? [0.20, 0.035];

          matches.push({
            page: p,
            type: fieldType,
            recipientOrder,
            x: clamp01(xPdf / pageW),
            y: clamp01(yPdfTop / pageH),
            w: defW,
            h: defH,
            marker: m[0]!,
          });
        }
      }
    }
  } finally {
    await doc.destroy();
  }
  return matches;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
