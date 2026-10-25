import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

/**
 * The parent's side of the seal job, against a child that misbehaves. The
 * worker is replaced by a script that drives `onRequest` and returns an
 * output the way a compromised child could.
 */

const mocks = vi.hoisted(() => ({
  envelopeFind: vi.fn(),
  signHex: vi.fn(async () => 'sig'),
  run: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock('../logger', () => ({
  childLogger: () => ({ info: vi.fn(), warn: mocks.logWarn, error: mocks.logError, debug: vi.fn() }),
  getLogger: () => ({ info: vi.fn(), warn: mocks.logWarn, error: mocks.logError, debug: vi.fn() }),
}));
vi.mock('../prisma', () => ({ prisma: { envelope: { findUnique: mocks.envelopeFind } } }));
vi.mock('../storage', () => ({ readPdfFromStorage: async () => Buffer.from('%PDF-1.7 source'), stageSealedPdf: vi.fn() }));
vi.mock('../crypto/org-key', () => ({
  getOrCreateOrgKey: async () => ({ keyId: 'key', fingerprint: 'fp', publicKeyPem: 'pem', algorithm: 'ed25519' }),
  signHex: mocks.signHex,
  signHexWithKey: async () => 'sig',
}));
vi.mock('../pdf-worker/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pdf-worker/runner')>()),
  runPdfJob: mocks.run,
}));

import { buildSealedEnvelope } from './seal';
import { PdfWorkerError } from '../pdf-worker/errors';
import type { SealRenderInput } from './seal-render';

type OnRequest = (body: unknown) => Promise<unknown>;
type Script = (input: SealRenderInput, onRequest: OnRequest) => Promise<unknown>;

const HEX = 'a'.repeat(64);
const digest = (pages = 2) => ({ algorithm: 'sha256', digestVersion: 3, pageCount: pages, pageDigests: Array(pages).fill(HEX) });
let pdf: Uint8Array;

function envelope() {
  return {
    id: 'env', orgId: 'org', title: 'Envelope', sentAt: null, completedAt: null,
    org: { name: 'Org', defaultFieldFont: 'mono' }, createdBy: { name: 'Sender', email: 'sender@example.com' },
    items: [{ id: 'item-0', order: 0, title: 'a.pdf', pageCount: 1, documentFile: { storagePath: 'a.pdf', sha256: 'b'.repeat(64) } }],
    recipients: [{
      id: 'r1', name: 'Alice', email: 'alice@example.com', recipientRole: 'SIGNER', signingOrder: 1,
      signingStatus: 'SIGNED', signedAt: new Date('2026-10-24T12:00:00Z'),
      signatures: [{ imagePngBase64: null, typedSignature: 'Alice', fieldId: 'f1' }],
    }],
    fields: [{
      id: 'f1', type: 'SIGNATURE', recipientId: 'r1', envelopeItemId: 'item-0', page: 1,
      // Prisma Decimals: objects with a prototype, which the IPC clone would strip.
      x: { toString: () => '0.25' }, y: { toString: () => '0.5' }, w: { toString: () => '0.2' }, h: { toString: () => '0.1' },
      value: null, meta: null, attachment: null, recipient: { name: 'Alice', email: 'alice@example.com' },
    }],
    auditEvents: [],
  };
}

/** Run the build with the worker replaced by `script`. */
function sealWith(script: Script) {
  mocks.run.mockImplementation(async (_kind: string, input: SealRenderInput, opts: { onRequest: OnRequest }) =>
    script(input, opts.onRequest));
  return buildSealedEnvelope({ envelopeId: 'env' });
}

const honest: Script = async (_input, ask) => {
  await ask({ sealedContent: digest() });
  return { bytes: pdf, warnings: [] };
};

async function crashed(promise: Promise<unknown>): Promise<void> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(PdfWorkerError);
  expect((err as PdfWorkerError).reason).toBe('crashed');
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.envelopeFind.mockResolvedValue(envelope());
  const doc = await PDFDocument.create();
  doc.addPage();
  pdf = await doc.save();
});

describe('buildSealedEnvelope as the parent of the seal job', () => {
  it('sends plain data: numeric coordinates, the source bytes and no key material', async () => {
    const build = await sealWith(honest);

    const input = mocks.run.mock.calls[0]![1] as SealRenderInput;
    expect(mocks.run.mock.calls[0]![0]).toBe('seal');
    expect(input.fieldFont).toBe('mono');
    expect(input.items[0]!.fields).toEqual([
      { type: 'SIGNATURE', page: 1, x: 0.25, y: 0.5, w: 0.2, h: 0.1, value: null, recipientId: 'r1', meta: null },
    ]);
    expect(input.items[0]!.bytes).toBeInstanceOf(Uint8Array);
    expect(input.auditPage.recipients[0]!.signedAt).toEqual(new Date('2026-10-24T12:00:00Z'));
    expect(JSON.stringify(input)).not.toMatch(/pem|fingerprint|privateKey/);
    expect(mocks.signHex).toHaveBeenCalledTimes(1);
    expect(build.manifest).toMatchObject({ sealedContent: digest(), manifestSignature: 'sig' });
    expect(Buffer.from(build.bytes).equals(Buffer.from(pdf))).toBe(true);
  });

  it('answers one signing request; a second one fails the job as crashed', async () => {
    const replies: unknown[] = [];
    await crashed(sealWith(async (_input, ask) => {
      replies.push(await ask({ sealedContent: digest() }));
      replies.push(await ask({ sealedContent: digest() }).catch((e: unknown) => e));
      return { bytes: pdf, warnings: [] };
    }));

    expect(mocks.signHex).toHaveBeenCalledTimes(1);
    expect(replies[0]).toBeInstanceOf(Uint8Array);
    expect(replies[1]).toBeInstanceOf(Error);
  });

  it.each([
    ['extra request key', { sealedContent: digest(), more: 1 }],
    ['missing sealedContent', {}],
    ['not an object', 'sign this'],
    ['legacy digest version', { sealedContent: { ...digest(), digestVersion: 2 } }],
    ['no digest version', { sealedContent: { algorithm: 'sha256', pageCount: 2, pageDigests: [HEX, HEX] } }],
    ['other algorithm', { sealedContent: { ...digest(), algorithm: 'md5' } }],
    ['extra digest key', { sealedContent: { ...digest(), note: 'x' } }],
    ['upper-case hex', { sealedContent: { ...digest(1), pageDigests: ['A'.repeat(64)] } }],
    ['short hex', { sealedContent: { ...digest(1), pageDigests: ['a'.repeat(63)] } }],
    ['digest list shorter than pageCount', { sealedContent: { ...digest(2), pageDigests: [HEX] } }],
    ['zero pages', { sealedContent: { ...digest(0) } }],
    ['fractional page count', { sealedContent: { ...digest(1), pageCount: 1.5 } }],
    ['more pages than the envelope cap allows', { sealedContent: digest(4002) }],
  ])('refuses a malformed signing request (%s) without signing', async (_name, body) => {
    await crashed(sealWith(async (_input, ask) => {
      await ask(body).catch(() => {});
      return { bytes: pdf, warnings: [] };
    }));
    expect(mocks.signHex).not.toHaveBeenCalled();
  });

  it('refuses a digest whose fields are getters', async () => {
    const sealedContent = { algorithm: 'sha256', digestVersion: 3, pageCount: 1, get pageDigests() { return [HEX]; } };
    await crashed(sealWith(async (_input, ask) => {
      await ask({ sealedContent }).catch(() => {});
      return { bytes: pdf, warnings: [] };
    }));
    expect(mocks.signHex).not.toHaveBeenCalled();
  });

  it('fails as crashed when the job finishes without asking for the manifest', async () => {
    await crashed(sealWith(async () => ({ bytes: pdf, warnings: [] })));
  });

  it.each([
    ['bytes not a typed array', () => ({ bytes: Array.from(pdf), warnings: [] })],
    ['empty bytes', () => ({ bytes: new Uint8Array(0), warnings: [] })],
    ['not a PDF', () => ({ bytes: new TextEncoder().encode('<html>'), warnings: [] })],
    ['extra output key', () => ({ bytes: pdf, warnings: [], extra: true })],
    ['warnings not an array', () => ({ bytes: pdf, warnings: 'none' })],
    ['unknown warning kind', () => ({ bytes: pdf, warnings: [{ kind: 'rm -rf', recipientId: 'r1', fieldType: 'SIGNATURE' }] })],
    ['warning for a recipient not in the input', () => ({ bytes: pdf, warnings: [{ kind: 'signature_image_embed_failed', recipientId: 'r9', fieldType: 'SIGNATURE' }] })],
    ['warning with free text', () => ({ bytes: pdf, warnings: [{ kind: 'signature_image_embed_failed', recipientId: 'r1', fieldType: 'SIGNATURE', err: 'x' }] })],
    ['more warnings than fields', () => ({
      bytes: pdf,
      warnings: [1, 2].map(() => ({ kind: 'signature_image_embed_failed', recipientId: 'r1', fieldType: 'SIGNATURE' })),
    })],
  ])('refuses a malformed job output (%s)', async (_name, output) => {
    await crashed(sealWith(async (_input, ask) => {
      await ask({ sealedContent: digest() });
      return output();
    }));
  });

  it('refuses output larger than the envelope cap plus headroom', async () => {
    vi.stubEnv('PDF_MAX_ENVELOPE_SEAL_BYTES', '1');
    const big = new Uint8Array(64 * 1024 * 1024 + 2);
    big.set(pdf.subarray(0, 8));
    await crashed(sealWith(async (_input, ask) => {
      await ask({ sealedContent: digest() });
      return { bytes: big, warnings: [] };
    }));
  });

  it('logs valid warnings at error level with fixed text', async () => {
    await sealWith(async (_input, ask) => {
      await ask({ sealedContent: digest() });
      return { bytes: pdf, warnings: [{ kind: 'signature_image_embed_failed', recipientId: 'r1', fieldType: 'SIGNATURE' }] };
    });

    expect(mocks.logError).toHaveBeenCalledWith(
      { envelopeId: 'env', recipientId: 'r1', fieldType: 'SIGNATURE' },
      'signature image embed failed; fell back to typed signature',
    );
  });

  it("rethrows the parent's own error when signing fails, not the generic one the child saw", async () => {
    const keyStoreDown = new Error('key store down');
    mocks.signHex.mockRejectedValueOnce(keyStoreDown);

    const err = await sealWith(async (_input, ask) => {
      await ask({ sealedContent: digest() });
      return { bytes: pdf, warnings: [] };
    }).catch((e: unknown) => e);

    expect(err).toBe(keyStoreDown);
  });

  it('passes a worker failure through', async () => {
    mocks.run.mockRejectedValue(new PdfWorkerError('busy'));
    const err = await buildSealedEnvelope({ envelopeId: 'env' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfWorkerError);
    expect((err as PdfWorkerError).reason).toBe('busy');
  });

  it('passes tighter worker limits to the job', async () => {
    mocks.run.mockImplementation(async (_kind: string, _input: unknown, opts: { onRequest: OnRequest }) => {
      await opts.onRequest({ sealedContent: digest() });
      return { bytes: pdf, warnings: [] };
    });
    await buildSealedEnvelope({ envelopeId: 'env', worker: { timeoutMs: 1234, queueMs: 567 } });
    expect(mocks.run.mock.calls[0]![2]).toMatchObject({ timeoutMs: 1234, queueMs: 567 });
  });
});
