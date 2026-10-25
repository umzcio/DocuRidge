import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { PDFDocument } from 'pdf-lib';
import { generatedTextFormPdf } from '@/lib/pdf/__fixtures__/hostile-form-pdf';
import { opaqueSquareOverText } from '@/lib/pdf/__fixtures__/policy-pdfs';
import {
  seedLegacyDocument,
  sha256,
  type Row,
} from '@/lib/documents/__fixtures__/stored-documents';

/** The sender's document route: sealed file by default, canonical copy before sealing, upload only (and always) on ?upload=1. */

const uploadsDir = mkdtempSync(join(tmpdir(), 'docuridge-dash-doc-route-'));
const sealedDir = mkdtempSync(join(tmpdir(), 'docuridge-dash-sealed-'));
const state = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  env: null as Record<string, unknown> | null,
  sealed: null as Record<string, unknown> | null,
  audit: [] as unknown[],
}));
vi.mock('@/lib/prisma', async () => {
  const { fakeDocumentFileTable } = await import('@/lib/documents/__fixtures__/stored-documents');
  return {
    prisma: {
      documentFile: fakeDocumentFileTable(state.rows),
      sealedDocument: { findUnique: async () => state.sealed },
    },
  };
});
vi.mock('@/lib/env', () => ({ getEnv: () => ({ UPLOADS_DIR: uploadsDir, SEALED_DIR: sealedDir }) }));
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ user: { id: 'u1' }, orgId: 'orgr', role: 'OWNER' }),
}));
vi.mock('@/lib/envelopes/service', () => ({ getEnvelopeForOwner: async () => state.env }));
vi.mock('@/lib/audit/envelope', () => ({
  recordEnvelopeEvent: async (e: unknown) => {
    state.audit.push(e);
  },
}));

const { GET } = await import('./route');

const UNAVAILABLE = "This document can't be shown right now. Contact the sender.";
const get = (query = '') =>
  GET(new NextRequest(`http://localhost/dashboard/envelopes/e1/document${query}`), {
    params: Promise.resolve({ id: 'e1' }),
  });
const body = async (res: Response) => Buffer.from(await res.arrayBuffer());

beforeEach(() => {
  state.rows.clear();
  state.sealed = null;
  state.env = null;
  state.audit.length = 0;
});
afterAll(() => {
  rmSync(uploadsDir, { recursive: true, force: true });
  rmSync(sealedDir, { recursive: true, force: true });
});

function envelopeOf(...ids: string[]) {
  return { id: 'e1', items: ids.map((id) => ({ id: `item-${id}`, documentFileId: id, documentFile: state.rows.get(id) })) };
}

describe('GET /dashboard/envelopes/[id]/document', () => {
  it('before sealing, the default is the canonical copy; ?upload=1 is the original', async () => {
    const original = await generatedTextFormPdf({ text: 'Alice' });
    const row = seedLegacyDocument(state.rows, uploadsDir, 'df1', original);
    state.env = envelopeOf('df1');

    const res = await get();
    expect(res.status).toBe(200);
    const canonical = await body(res);
    expect(canonical.equals(original)).toBe(false);
    expect(sha256(canonical)).toBe(state.rows.get('df1')!.canonicalSha256);

    // Previews are not recorded; the original's download is.
    expect(state.audit).toHaveLength(0);
    const up = await body(await get('?upload=1'));
    expect(sha256(up)).toBe(row.sha256);
    expect(state.audit).toEqual([expect.objectContaining({
      envelopeId: 'e1', type: 'envelope.downloaded', actorUserId: 'u1', data: { itemId: 'item-df1', variant: 'original' },
    })]);
  });

  it('after sealing, the default is the sealed file and ?original=1 is the canonical copy', async () => {
    const original = await generatedTextFormPdf({ text: 'Alice' });
    seedLegacyDocument(state.rows, uploadsDir, 'df1', original);
    state.env = envelopeOf('df1');
    const sealedBytes = await (async () => {
      const d = await PDFDocument.create();
      d.addPage([100, 100]);
      return d.save();
    })();
    writeFileSync(join(sealedDir, 'sealed.pdf'), sealedBytes);
    state.sealed = { documentFile: { storagePath: 'sealed.pdf' } };

    expect(sha256(await body(await get()))).toBe(sha256(sealedBytes));
    const pre = await get('?original=1');
    expect(pre.status).toBe(200);
    expect(sha256(await body(pre))).toBe(state.rows.get('df1')!.canonicalSha256);
    // ?upload=1 is the uploaded original whether or not the envelope is sealed.
    expect(sha256(await body(await get('?upload=1')))).toBe(sha256(original));
    expect(state.audit).toHaveLength(1);
  });

  it('?item=N picks the item, and a refused document answers 409 instead of the original', async () => {
    const good = await generatedTextFormPdf({ text: 'Bob' });
    const refused = Buffer.from(await (await opaqueSquareOverText()).doc.save({ useObjectStreams: false }));
    seedLegacyDocument(state.rows, uploadsDir, 'dfa', good);
    seedLegacyDocument(state.rows, uploadsDir, 'dfb', refused);
    state.env = envelopeOf('dfa', 'dfb');

    expect((await get('?item=0')).status).toBe(200);
    const res = await get('?item=1');
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(UNAVAILABLE);
  });

  it('?item=N on a canonical file whose bytes changed answers 409', async () => {
    const original = await generatedTextFormPdf({ text: 'Alice' });
    seedLegacyDocument(state.rows, uploadsDir, 'df1', original);
    state.env = envelopeOf('df1');
    expect((await get()).status).toBe(200);
    const row = state.rows.get('df1')!;
    writeFileSync(join(uploadsDir, row.canonicalStoragePath as string), original);
    expect((await get()).status).toBe(409);
  });
});
