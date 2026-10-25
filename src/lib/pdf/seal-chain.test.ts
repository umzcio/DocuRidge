import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ed from '@noble/ed25519';
import { PDFDocument } from 'pdf-lib';

/**
 * The sealed evidence (manifest audit chain, the drawn Events page, the
 * stored chain head) must end with envelope.completed and be the same
 * whether the seal was built before the completion claim (the normal path)
 * or after it (a retry for a COMPLETED envelope). Real hashing, real
 * Ed25519 signatures, and the real verifier.
 */

const state = vi.hoisted(() => ({
  envelope: null as unknown as Record<string, unknown>,
  rows: new Map<string, Record<string, unknown> & { id: string }>(),
  uploadsDir: '',
  key: null as unknown as {
    keyId: string; fingerprint: string; algorithm: 'ed25519';
    privateKey: Uint8Array; publicKey: Uint8Array; publicKeyPem: string;
  },
}));

vi.mock('../prisma', async () => {
  const { fakeDocumentFileTable } = await import('../documents/__fixtures__/stored-documents');
  return { prisma: { envelope: { findUnique: async () => state.envelope }, documentFile: fakeDocumentFileTable(state.rows) } };
});
vi.mock('../env', () => ({ getEnv: () => ({ UPLOADS_DIR: state.uploadsDir }) }));
vi.mock('../crypto/org-key', async () => {
  const { hexToBytes } = await import('../audit/canonical');
  const sign = async (hex: string) => Buffer.from(await ed.signAsync(hexToBytes(hex), state.key.privateKey)).toString('hex');
  return {
    getOrCreateOrgKey: async () => state.key,
    getOrgKeyForVerify: async () => null,
    signHex: async (_orgId: string, hex: string) => sign(hex),
    signHexWithKey: async (_key: unknown, hex: string) => sign(hex),
  };
});

import { buildSealedEnvelope } from './seal';
import { prepareEnvelopeEvent, type PreparedEnvelopeEvent } from '../audit/envelope';
import { verifySealedPdf } from '../verify/sealed-pdf';
import { makeTestKey } from '../verify/__fixtures__/sealed-pdf';
import { seedCanonicalDocument } from '../documents/__fixtures__/stored-documents';

state.uploadsDir = mkdtempSync(join(tmpdir(), 'docuridge-seal-chain-'));
afterAll(() => rmSync(state.uploadsDir, { recursive: true, force: true }));

const COMPLETED_AT = new Date('2026-10-24T15:30:00.000Z');
let history: PreparedEnvelopeEvent[];

beforeAll(async () => {
  const test = await makeTestKey();
  state.key = {
    keyId: 'key1', fingerprint: test.fingerprint, algorithm: 'ed25519', privateKey: test.privateKey,
    publicKey: await ed.getPublicKeyAsync(test.privateKey), publicKeyPem: test.publicKeyPem,
  };
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]).drawText('CONTRACT', { x: 50, y: 700 });
  await seedCanonicalDocument(state.rows, state.uploadsDir, 'df1', await doc.save());
});

beforeEach(async () => {
  history = [];
  const times = ['2026-10-24T15:00:00.000Z', '2026-10-24T15:10:00.000Z', '2026-10-24T15:20:00.000Z'];
  const types = ['envelope.created', 'envelope.sent', 'recipient.signed'] as const;
  for (const [i, type] of types.entries()) {
    const prior = history.at(-1) ?? null;
    history.push(await prepareEnvelopeEvent({
      key: state.key, prior, createdAt: new Date(times[i]!),
      event: { envelopeId: 'env1', type, ...(type === 'recipient.signed' ? { actorRecipientId: 'r1' } : { actorUserId: 'u1' }) },
    }));
  }
});

function envelope(status: string, auditEvents: PreparedEnvelopeEvent[], completedAt: Date | null) {
  return {
    id: 'env1', orgId: 'org1', title: 'Contract', status, sentAt: new Date('2026-10-24T15:10:00.000Z'), completedAt,
    org: { name: 'Org' }, createdBy: { name: 'Sender', email: 'sender@example.com' },
    items: [{ id: 'item1', order: 1, title: 'doc.pdf', pageCount: 1, documentFileId: 'df1', documentFile: state.rows.get('df1') }],
    recipients: [{
      id: 'r1', name: 'Alice', email: 'alice@example.com', recipientRole: 'SIGNER', signingOrder: 1,
      signingStatus: 'SIGNED', signedAt: new Date('2026-10-24T15:20:00.000Z'), signatures: [],
    }],
    fields: [],
    auditEvents,
  };
}

const trust = () => ({ trust: { publicKeys: [], fingerprints: [state.key.fingerprint], source: 'test' } });
type Chain = { auditChain: { head: string; length: number; events: Array<{ type: string; createdAt: string; eventHash: string }> } };

describe('the sealed chain ends with envelope.completed on every path', () => {
  it('includes the precomputed envelope.completed when built before the claim, and verifies', async () => {
    state.envelope = envelope('IN_PROGRESS', history, null);

    const build = await buildSealedEnvelope({
      envelopeId: 'env1',
      completion: { completedAt: COMPLETED_AT, actor: { ipAddress: '203.0.113.9', userAgent: 'vitest' } },
    });

    const chain = (build.manifest as unknown as Chain).auditChain;
    expect(chain.events.map((e) => e.type)).toEqual(['envelope.created', 'envelope.sent', 'recipient.signed', 'envelope.completed']);
    expect(chain.events.at(-1)!.createdAt).toBe(COMPLETED_AT.toISOString());
    expect(build.completionEvent).toMatchObject({ type: 'envelope.completed', seq: 4, prevHash: history[2]!.eventHash });
    expect(chain.head).toBe(build.completionEvent!.eventHash);
    expect(build.chainHeadHash).toBe(build.completionEvent!.eventHash);

    const result = await verifySealedPdf(build.bytes, trust());
    expect(result.reason).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('produces the same evidence when a retry seals the already-COMPLETED envelope', async () => {
    state.envelope = envelope('IN_PROGRESS', history, null);
    const normal = await buildSealedEnvelope({
      envelopeId: 'env1',
      completion: { completedAt: COMPLETED_AT, actor: { ipAddress: '203.0.113.9', userAgent: 'vitest' } },
    });

    // The claim stored exactly the precomputed event; the retry reads it back.
    state.envelope = envelope('COMPLETED', [...history, normal.completionEvent!], COMPLETED_AT);
    const retry = await buildSealedEnvelope({ envelopeId: 'env1' });

    expect(retry.completionEvent).toBeUndefined();
    const m = (b: typeof normal) => b.manifest as unknown as Chain & { envelope: unknown; recipients: unknown; sealedContent: unknown };
    expect(m(retry).auditChain).toEqual(m(normal).auditChain);
    expect(m(retry).envelope).toEqual(m(normal).envelope);
    expect(m(retry).recipients).toEqual(m(normal).recipients);
    // Same rendered pages, Events page included.
    expect(m(retry).sealedContent).toEqual(m(normal).sealedContent);
    expect(retry.chainHeadHash).toBe(normal.chainHeadHash);
    expect((await verifySealedPdf(retry.bytes, trust())).ok).toBe(true);
  });
});
