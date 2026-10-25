import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ed from '@noble/ed25519';
import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * Sealing in a real PDF worker child (process mode, the tsx source entry):
 * the child renders and digests, the parent alone holds the org key and
 * signs the manifest.
 */

const state = vi.hoisted(() => ({
  envelope: null as unknown as Record<string, unknown>,
  sources: new Map<string, Buffer>(),
  key: null as unknown as {
    keyId: string; fingerprint: string; algorithm: 'ed25519';
    privateKey: Uint8Array; publicKey: Uint8Array; publicKeyPem: string;
  },
  signHex: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
}));

vi.mock('../logger', () => {
  const quiet = () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
  return { getLogger: quiet, childLogger: quiet };
});
vi.mock('../prisma', () => ({ prisma: { envelope: { findUnique: async () => state.envelope } } }));
vi.mock('../storage', () => ({ readPdfFromStorage: async (p: string) => state.sources.get(p)! }));
vi.mock('../crypto/org-key', async () => {
  const { vi: v } = await import('vitest');
  const { hexToBytes } = await import('../audit/canonical');
  const sign = async (hex: string) => Buffer.from(await ed.signAsync(hexToBytes(hex), state.key.privateKey)).toString('hex');
  state.signHex = v.fn(async (_orgId: string, hex: string) => sign(hex));
  return {
    getOrCreateOrgKey: async () => state.key,
    getOrgKeyForVerify: async () => null,
    signHex: (orgId: string, hex: string) => state.signHex(orgId, hex),
    signHexWithKey: async (_key: unknown, hex: string) => sign(hex),
  };
});

import { buildSealedEnvelope, containsAttachedManifest } from './seal';
import { PdfWorkerError } from '../pdf-worker/errors';
import { prepareEnvelopeEvent, type PreparedEnvelopeEvent } from '../audit/envelope';
import { verifySealedPdf } from '../verify/sealed-pdf';
import { makeTestKey } from '../verify/__fixtures__/sealed-pdf';
import { sharedResourceDictPdf } from './__fixtures__/shared-resource-pdf';

const SAVED_ENV = { ...process.env };
function restoreEnv(): void {
  for (const k of Object.keys(process.env)) if (!(k in SAVED_ENV)) delete process.env[k];
  Object.assign(process.env, SAVED_ENV);
}

let history: PreparedEnvelopeEvent[] = [];

async function textPdf(pages: number, text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`${text} ${i + 1}`, { x: 50, y: 700, size: 14, font });
  return Buffer.from(await doc.save());
}

function envelope(paths: string[]) {
  return {
    id: 'env1', orgId: 'org1', title: 'Contract', status: 'COMPLETED',
    sentAt: new Date('2026-10-24T15:10:00.000Z'), completedAt: new Date('2026-10-24T15:30:00.000Z'),
    org: { name: 'Org', defaultFieldFont: 'serif' }, createdBy: { name: 'Sender', email: 'sender@example.com' },
    items: paths.map((path, i) => ({
      id: `item${i}`, order: i + 1, title: path, pageCount: 1,
      documentFile: { storagePath: path, sha256: 'a'.repeat(64) },
    })),
    recipients: [{
      id: 'r1', name: 'Alice', email: 'alice@example.com', recipientRole: 'SIGNER', signingOrder: 1,
      signingStatus: 'SIGNED', signedAt: new Date('2026-10-24T15:20:00.000Z'),
      signatures: [{ imagePngBase64: null, typedSignature: 'Alice Signer', fieldId: 'f1' }],
    }],
    fields: [
      // Prisma returns Decimal coordinates; the parent turns them into numbers.
      {
        id: 'f1', type: 'SIGNATURE', recipientId: 'r1', envelopeItemId: 'item0', page: 1,
        x: { toString: () => '0.1' }, y: { toString: () => '0.8' }, w: { toString: () => '0.3' }, h: { toString: () => '0.05' },
        value: null, meta: null, attachment: null, recipient: { name: 'Alice', email: 'alice@example.com' },
      },
      {
        id: 'f2', type: 'TEXT', recipientId: 'r1', envelopeItemId: 'item1', page: 1,
        x: 0.1, y: 0.5, w: 0.3, h: 0.05, value: 'Typed answer', meta: null, attachment: null,
        recipient: { name: 'Alice', email: 'alice@example.com' },
      },
    ],
    auditEvents: history,
  };
}

const trust = () => ({ trust: { publicKeys: [], fingerprints: [state.key.fingerprint], source: 'test' } });

beforeAll(async () => {
  const test = await makeTestKey();
  state.key = {
    keyId: 'key1', fingerprint: test.fingerprint, algorithm: 'ed25519', privateKey: test.privateKey,
    publicKey: await ed.getPublicKeyAsync(test.privateKey), publicKeyPem: test.publicKeyPem,
  };
  history = [];
  const times = ['2026-10-24T15:00:00.000Z', '2026-10-24T15:10:00.000Z', '2026-10-24T15:20:00.000Z', '2026-10-24T15:30:00.000Z'];
  const types = ['envelope.created', 'envelope.sent', 'recipient.signed', 'envelope.completed'] as const;
  for (const [i, type] of types.entries()) {
    history.push(await prepareEnvelopeEvent({
      key: state.key, prior: history.at(-1) ?? null, createdAt: new Date(times[i]!),
      event: { envelopeId: 'env1', type, actorUserId: 'u1' },
    }));
  }
});

afterAll(restoreEnv);

describe('buildSealedEnvelope in a real PDF worker', () => {
  beforeEach(() => {
    restoreEnv();
    process.env.PDF_WORKER_MODE = 'process';
    state.sources.clear();
    state.signHex.mockClear();
  });
  afterEach(restoreEnv);

  it('a real child seals a two-document envelope and the result verifies', async () => {
    state.sources.set('org1/a.pdf', await textPdf(2, 'first'));
    state.sources.set('org1/b.pdf', await textPdf(1, 'second'));
    state.envelope = envelope(['org1/a.pdf', 'org1/b.pdf']);

    const build = await buildSealedEnvelope({ envelopeId: 'env1' });

    const result = await verifySealedPdf(build.bytes, trust());
    expect(result.reason).toBeUndefined();
    expect(result.ok).toBe(true);
    expect((await PDFDocument.load(build.bytes)).getPageCount()).toBe(4);
    expect(build.manifest).toMatchObject({ sealedContent: { digestVersion: 3, pageCount: 4 } });
    expect(build.chainHeadHash).toBe(history.at(-1)!.eventHash);
    // The parent's byte check passed on the child's real output: the file
    // attaches exactly the manifest the parent signed.
    expect(containsAttachedManifest(build.bytes, new TextEncoder().encode(JSON.stringify(build.manifest)))).toBe(true);
  }, 30_000);

  it('the child never sees the org key', async () => {
    state.sources.set('org1/a.pdf', await textPdf(1, 'only'));
    state.envelope = envelope(['org1/a.pdf']);

    const build = await buildSealedEnvelope({ envelopeId: 'env1' });

    // The one signature is made here, in the parent, over the manifest hash.
    expect(state.signHex).toHaveBeenCalledTimes(1);
    expect(state.signHex.mock.calls[0]).toEqual(['org1', (build.manifest as { manifestSha256: string }).manifestSha256]);
    expect(build.manifestSignature).toBe((build.manifest as { manifestSignature: string }).manifestSignature);
    expect((await verifySealedPdf(build.bytes, trust())).ok).toBe(true);
  }, 30_000);

  it('a seal whose digest exceeds the time limit fails cleanly', async () => {
    // Loads, copies and saves in about 2 s, but the digest walks the 20k
    // shared objects once per page: about 100 s in-process.
    state.sources.set('org1/huge.pdf', await sharedResourceDictPdf(2000, 20_000));
    state.envelope = { ...envelope(['org1/huge.pdf']), fields: [] };
    process.env.PDF_JOB_TIMEOUT_SEAL_MS = '2000';

    let ticks = 0;
    let last = Date.now();
    let maxGap = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks++;
    }, 10);
    try {
      const started = Date.now();
      const err = await buildSealedEnvelope({ envelopeId: 'env1' }).catch((e: unknown) => e);
      const elapsed = Date.now() - started;

      expect(err).toBeInstanceOf(PdfWorkerError);
      expect((err as PdfWorkerError).reason).toBe('timeout');
      expect(elapsed).toBeLessThan(4000);
      expect(state.signHex).not.toHaveBeenCalled();
      // The parent's event loop kept running while the child worked.
      expect(ticks).toBeGreaterThanOrEqual(Math.floor(elapsed / 10 / 4));
      expect(maxGap).toBeLessThan(500);
    } finally {
      clearInterval(timer);
    }
  }, 60_000);
});
