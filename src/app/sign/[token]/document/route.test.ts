import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';
import { generatedTextFormPdf } from '@/lib/pdf/__fixtures__/hostile-form-pdf';
import { opaqueSquareOverText } from '@/lib/pdf/__fixtures__/policy-pdfs';
import {
  seedLegacyDocument,
  sha256,
  type Row,
} from '@/lib/documents/__fixtures__/stored-documents';

/**
 * The recipient's document route serves the canonical copy or nothing. The
 * real gate, canonical-source, storage and canonicalizer run; only the
 * session, the document_file table and the uploads dir are stand-ins.
 */

const uploadsDir = mkdtempSync(join(tmpdir(), 'docuridge-sign-doc-route-'));
const state = vi.hoisted(() => ({ rows: new Map<string, Row>(), session: { ok: true } as Record<string, unknown> }));
vi.mock('@/lib/prisma', async () => {
  const { fakeDocumentFileTable } = await import('@/lib/documents/__fixtures__/stored-documents');
  return { prisma: { documentFile: fakeDocumentFileTable(state.rows) } };
});
vi.mock('@/lib/env', () => ({ getEnv: () => ({ UPLOADS_DIR: uploadsDir }) }));
vi.mock('@/lib/signing/session-gate', () => ({ loadGatedSigningSession: async () => state.session }));
vi.mock('@/lib/pdf-worker/runner', async (orig) => {
  const actual = await orig<typeof import('@/lib/pdf-worker/runner')>();
  return { ...actual, runPdfJob: vi.fn(actual.runPdfJob) };
});

const { GET } = await import('./route');
const { runPdfJob, PdfWorkerError } = await import('@/lib/pdf-worker/runner');
const { canonicalizeUploadedPdf } = await import('@/lib/pdf/canonicalize');
const { writeCanonicalPdf } = await import('@/lib/storage');
const { CURRENT_CANONICAL_VERSION } = await import('@/lib/pdf/canonical-source');

const UNAVAILABLE = "This document can't be shown right now. Contact the sender.";

async function pdf(label: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]).drawText(label);
  return doc.save();
}

function sessionFor(...documentFileIds: string[]) {
  return {
    ok: true,
    envelope: {
      items: documentFileIds.map((documentFileId, i) => ({
        id: `item${i}`,
        documentFileId,
        documentFile: state.rows.get(documentFileId),
      })),
    },
  };
}

const get = (query = '') =>
  GET(new NextRequest(`http://localhost/sign/tok/document${query}`), { params: Promise.resolve({ token: 'tok' }) });

/** Give a legacy row its canonical copy, as upload does. */
async function withCanonical(row: Row, original: Uint8Array): Promise<Uint8Array> {
  const result = await canonicalizeUploadedPdf(original);
  if (!result.ok) throw new Error(result.key);
  const written = await writeCanonicalPdf({ orgId: row.orgId as string, bytes: result.bytes });
  Object.assign(row, {
    canonicalStoragePath: written.relativePath,
    canonicalSha256: written.sha256,
    canonicalVersion: CURRENT_CANONICAL_VERSION,
    canonicalPageCount: result.pageCount,
    canonicalSealCost: { ...result.sealCost },
  });
  return result.bytes;
}

beforeEach(() => {
  state.rows.clear();
  state.session = { ok: true };
  vi.mocked(runPdfJob).mockClear();
});
afterAll(() => rmSync(uploadsDir, { recursive: true, force: true }));

describe('GET /sign/[token]/document', () => {
  it('serves the canonical bytes, never the original', async () => {
    const original = await generatedTextFormPdf({ text: 'Alice' });
    const row = seedLegacyDocument(state.rows, uploadsDir, 'df1', original);
    await withCanonical(row, original);
    state.session = sessionFor('df1');

    const res = await get();
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(sha256(body)).toBe(row.canonicalSha256);
    expect(sha256(body)).not.toBe(row.sha256);
  });

  it('serves the item picked by ?item=', async () => {
    const a = await pdf('first');
    const b = await pdf('second');
    const rowA = seedLegacyDocument(state.rows, uploadsDir, 'dfa', a);
    const rowB = seedLegacyDocument(state.rows, uploadsDir, 'dfb', b);
    await withCanonical(rowA, a);
    await withCanonical(rowB, b);
    state.session = sessionFor('dfa', 'dfb');
    const res = await get('?item=item1');
    expect(sha256(Buffer.from(await res.arrayBuffer()))).toBe(rowB.canonicalSha256);
  });

  it('a refused legacy document answers 409 and never serves the original', async () => {
    const original = await opaqueSquareOverText();
    const bytes = Buffer.from(await original.doc.save({ useObjectStreams: false }));
    seedLegacyDocument(state.rows, uploadsDir, 'df1', bytes);
    state.session = sessionFor('df1');

    const res = await get();
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toBe(UNAVAILABLE);
    expect(res.headers.get('content-type')).not.toBe('application/pdf');
    expect(state.rows.get('df1')!.canonicalRefusal).toBe('visible_annotations');
  });

  it('a canonical file whose bytes changed answers 409', async () => {
    const original = await pdf('real');
    const row = seedLegacyDocument(state.rows, uploadsDir, 'df1', original);
    await withCanonical(row, original);
    writeFileSync(join(uploadsDir, row.canonicalStoragePath as string), await pdf('forged'));
    state.session = sessionFor('df1');

    const res = await get();
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(UNAVAILABLE);
  });

  it('busy answers 503 with Retry-After', async () => {
    seedLegacyDocument(state.rows, uploadsDir, 'df1', await pdf('x'));
    state.session = sessionFor('df1');
    vi.mocked(runPdfJob).mockRejectedValueOnce(new PdfWorkerError('busy'));

    const res = await get();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.text()).toBe(UNAVAILABLE);
  });

  it('a crashed worker answers 409 without echoing the error', async () => {
    seedLegacyDocument(state.rows, uploadsDir, 'df1', await pdf('x'));
    state.session = sessionFor('df1');
    vi.mocked(runPdfJob).mockRejectedValueOnce(new PdfWorkerError('crashed', 'secret detail'));

    const res = await get();
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(UNAVAILABLE);
  });

  it('an unknown token or item is refused without touching storage', async () => {
    state.session = { ok: false };
    expect((await get()).status).toBe(403);
    seedLegacyDocument(state.rows, uploadsDir, 'df1', await pdf('x'));
    state.session = sessionFor('df1');
    expect((await get('?item=nope')).status).toBe(404);
  });

  it('missing /AP text field: the served file shows the generated appearance', async () => {
    const original = await generatedTextFormPdf({ text: 'Alice' });
    seedLegacyDocument(state.rows, uploadsDir, 'df1', original);
    state.session = sessionFor('df1');

    const res = await get();
    expect(res.status).toBe(200);
    const served = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()), { updateMetadata: false });
    const page = served.getPages()[0]!;
    // Follow the page's content through every Form XObject it draws.
    const text = (stream: PDFRawStream) => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
    const contents = page.node.Contents();
    const pageStreams = (contents instanceof PDFArray ? contents.asArray() : [contents]).map(
      (s) => served.context.lookup(s as PDFRef) as PDFRawStream,
    );
    const forms: string[] = [];
    const walk = (content: string, resources: PDFDict | undefined) => {
      const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      for (const [, name] of content.matchAll(/\/(\S+)\s+Do\b/g)) {
        if (name === undefined) continue;
        const form = xobjects?.lookup(PDFName.of(name)) as PDFRawStream | undefined;
        if (!form || form.dict.get(PDFName.of('Subtype')) !== PDFName.of('Form')) continue;
        forms.push(text(form));
        walk(text(form), form.dict.lookupMaybe(PDFName.of('Resources'), PDFDict));
      }
    };
    for (const s of pageStreams) walk(text(s), page.node.Resources());
    expect(forms.length).toBeGreaterThan(0);
    // The field's value is drawn by a form, and the page itself draws no text.
    expect(pageStreams.map(text).join('')).not.toMatch(/\bTj\b|\bTJ\b/);
    expect(forms.join('\n')).toMatch(/\(Alice\)\s*Tj|<(?:00)?41(?:00)?6c(?:00)?69(?:00)?63(?:00)?65>\s*Tj/i);
  });
});
