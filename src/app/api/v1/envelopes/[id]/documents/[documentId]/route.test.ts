import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { generatedTextFormPdf } from '@/lib/pdf/__fixtures__/hostile-form-pdf';
import { opaqueSquareOverText } from '@/lib/pdf/__fixtures__/policy-pdfs';
import {
  seedLegacyDocument,
  sha256,
  type Row,
} from '@/lib/documents/__fixtures__/stored-documents';

/** The API download: canonical by default, the original only with ?original=1; both audited. */

const uploadsDir = mkdtempSync(join(tmpdir(), 'docuridge-api-doc-route-'));
const state = vi.hoisted(() => ({ rows: new Map<string, Row>(), env: null as Record<string, unknown> | null, audit: [] as unknown[] }));
vi.mock('@/lib/prisma', async () => {
  const { fakeDocumentFileTable } = await import('@/lib/documents/__fixtures__/stored-documents');
  return {
    prisma: {
      documentFile: fakeDocumentFileTable(state.rows),
      envelope: { findFirst: async () => state.env },
    },
  };
});
vi.mock('@/lib/env', () => ({ getEnv: () => ({ UPLOADS_DIR: uploadsDir }) }));
vi.mock('@/lib/api/guard', () => ({
  guardApiRequest: async () => ({ ok: true, auth: { token: { orgId: 'orgr', userId: 'u1' } } }),
  notFoundJson: (m: string) => NextResponse.json({ error: m }, { status: 404 }),
}));
vi.mock('@/lib/api/auth', () => ({ resolveApiActor: async () => ({ userId: 'u1', orgId: 'orgr', role: 'OWNER' }) }));
vi.mock('@/lib/authz/can', () => ({
  authorize: () => undefined,
  AuthorizationError: class extends Error {},
}));
vi.mock('@/lib/audit/envelope', () => ({
  recordEnvelopeEvent: async (e: unknown) => {
    state.audit.push(e);
  },
}));
vi.mock('@/lib/pdf-worker/runner', async (orig) => {
  const actual = await orig<typeof import('@/lib/pdf-worker/runner')>();
  return { ...actual, runPdfJob: vi.fn(actual.runPdfJob) };
});

const { GET } = await import('./route');
const { runPdfJob, PdfWorkerError } = await import('@/lib/pdf-worker/runner');

const UNAVAILABLE = "This document can't be shown right now. Contact the sender.";
const get = (query = '') =>
  GET(new NextRequest(`http://localhost/api/v1/envelopes/e1/documents/item1${query}`), {
    params: Promise.resolve({ id: 'e1', documentId: 'item1' }),
  });

function envelopeOf(id: string) {
  return {
    id: 'e1',
    orgId: 'orgr',
    createdById: 'u1',
    items: [{ id: 'item1', title: 'Doc', documentFileId: id, documentFile: state.rows.get(id) }],
  };
}

beforeEach(() => {
  state.rows.clear();
  state.audit.length = 0;
  vi.mocked(runPdfJob).mockClear();
});
afterAll(() => rmSync(uploadsDir, { recursive: true, force: true }));

describe('GET /api/v1/envelopes/[id]/documents/[documentId]', () => {
  it('serves the canonical copy by default and the original with ?original=1, auditing both', async () => {
    const original = await generatedTextFormPdf({ text: 'Alice' });
    const row = seedLegacyDocument(state.rows, uploadsDir, 'df1', original);
    state.env = envelopeOf('df1');

    const res = await get();
    expect(res.status).toBe(200);
    const canonical = Buffer.from(await res.arrayBuffer());
    expect(sha256(canonical)).toBe(state.rows.get('df1')!.canonicalSha256);
    expect(sha256(canonical)).not.toBe(row.sha256);
    expect(state.audit).toHaveLength(1);

    const orig = Buffer.from(await (await get('?original=1')).arrayBuffer());
    expect(sha256(orig)).toBe(row.sha256);
    expect(state.audit).toHaveLength(2);
  });

  it('a refused document answers 409 in the JSON error shape, with no download recorded', async () => {
    const bytes = Buffer.from(await (await opaqueSquareOverText()).doc.save({ useObjectStreams: false }));
    seedLegacyDocument(state.rows, uploadsDir, 'df1', bytes);
    state.env = envelopeOf('df1');

    const res = await get();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: UNAVAILABLE });
    expect(state.audit).toHaveLength(0);
  });

  it('busy answers 503 with Retry-After', async () => {
    seedLegacyDocument(state.rows, uploadsDir, 'df1', await generatedTextFormPdf({ text: 'x' }));
    state.env = envelopeOf('df1');
    vi.mocked(runPdfJob).mockRejectedValueOnce(new PdfWorkerError('busy'));

    const res = await get();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.json()).toEqual({ error: UNAVAILABLE });
  });
});
