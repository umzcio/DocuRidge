/**
 * Test fixtures: a sealed PDF built the way src/lib/pdf/seal.ts builds one
 * (source page embedded as a Form XObject, digest taken from the saved body,
 * signed manifest attached afterwards), signed with a throwaway key.
 */
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import * as ed from '@noble/ed25519';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { canonicalJson, hexToBytes, sha256Hex } from '../../audit/canonical';
import { appendUprightPage } from '../../pdf/upright-page';
import {
  CURRENT_SEALED_CONTENT_DIGEST_VERSION,
  sealedContentDigestFromBytes,
  type SealedContentDigestVersion,
} from '../../pdf/content-digest';

export interface TestKey {
  privateKey: Uint8Array;
  publicKeyPem: string;
  fingerprint: string;
}

export async function makeTestKey(): Promise<TestKey> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const b64 = Buffer.from(publicKey).toString('base64');
  return {
    privateKey,
    publicKeyPem: `-----BEGIN DOCURIDGE ED25519 PUBLIC KEY-----\n${b64}\n-----END DOCURIDGE ED25519 PUBLIC KEY-----\n`,
    fingerprint: createHash('sha256').update(publicKey).digest('hex'),
  };
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A tiny solid-colour RGB PNG. */
export function solidPng(r: number, g: number, b: number, size = 4): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Source document: text in Helvetica plus an image, as an uploaded contract would have. */
async function buildSource(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const image = await doc.embedPng(solidPng(0, 0, 255));
  const page = doc.addPage([612, 792]);
  page.drawText('CONTRACT AMOUNT: $10,000', { x: 50, y: 700, size: 14, font, color: rgb(0, 0, 0) });
  page.drawImage(image, { x: 50, y: 600, width: 40, height: 40 });
  return PDFDocument.load(await doc.save());
}

export async function buildSealedPdf(opts: {
  key: TestKey;
  digestVersion?: SealedContentDigestVersion;
  /** Override the signed manifest's digestVersion (to simulate unknown versions). */
  declaredDigestVersion?: number;
  /** Build a legacy (v1) manifest: no sealedContent, so the body is not bound. */
  legacyManifest?: boolean;
  /** Append a second page, as the sealer's audit page. */
  auditPage?: boolean;
  /** The manifest's `documents` (default none). */
  documents?: Array<Record<string, unknown>>;
}): Promise<Uint8Array> {
  const source = await buildSource();
  const out = await PDFDocument.create();
  const page = await appendUprightPage(out, source.getPage(0));
  const helv = await out.embedFont(StandardFonts.Helvetica);
  page.drawText('Signed: Test Signer', { x: 300, y: 100, size: 12, font: helv });
  const signature = await out.embedPng(solidPng(20, 20, 20, 8));
  page.drawImage(signature, { x: 300, y: 120, width: 80, height: 30 });
  if (opts.auditPage) {
    out.addPage([612, 792]).drawText('Audit trail: completed', { x: 50, y: 700, size: 12, font: helv });
  }

  const body = await out.save();
  const sealedContent: Record<string, unknown> = {
    ...(await sealedContentDigestFromBytes(body, opts.digestVersion ?? CURRENT_SEALED_CONTENT_DIGEST_VERSION)),
  };
  if (opts.declaredDigestVersion !== undefined) sealedContent.digestVersion = opts.declaredDigestVersion;

  const manifest = {
    version: opts.legacyManifest ? 1 : 3,
    generator: 'DocuRidge',
    envelope: { id: 'env_test', orgId: 'org_test', title: 'Test', sentAt: null, completedAt: null },
    signedBy: { keyId: 'key_test', fingerprint: opts.key.fingerprint, algorithm: 'ed25519', publicKeyPem: opts.key.publicKeyPem },
    documents: opts.documents ?? [],
    ...(opts.legacyManifest ? {} : { sealedContent }),
    recipients: [],
    auditChain: { head: null, length: 0, events: [] },
  };
  const manifestSha256 = await sha256Hex(canonicalJson({ ...manifest, manifestSha256: undefined, manifestSignature: undefined }));
  const manifestSignature = Buffer.from(await ed.signAsync(hexToBytes(manifestSha256), opts.key.privateKey)).toString('hex');
  await out.attach(
    new TextEncoder().encode(JSON.stringify({ ...manifest, manifestSha256, manifestSignature })),
    'docuridge-manifest.json',
    { mimeType: 'application/json' },
  );
  return out.save();
}
