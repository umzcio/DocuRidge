#!/usr/bin/env tsx
/**
 * DocuRidge — verify command.
 *
 * Usage:
 *   docker compose -p docuridge exec app npm run verify -- <sealed.pdf>
 *
 * Reads the embedded `docuridge-manifest.json` from the sealed PDF, walks the
 * audit chain, recomputes every event hash, and verifies every signature
 * against the public key embedded in the manifest. Exits 0 on full pass,
 * non-zero with a diagnostic message on any tamper.
 *
 * The verifier is INTENTIONALLY self-contained — it does not consult the
 * database. The sealed PDF is the canonical evidence, and verification only
 * needs the embedded manifest plus the embedded public key. (Trust in the
 * key itself — i.e. that it really represents the issuing org — comes from
 * the deployment context. Production may use a CA-issued cert with PAdES.)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFHexString, PDFString } from 'pdf-lib';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

interface ManifestEvent {
  seq: number;
  type: string;
  createdAt: string;
  actor: { userId: string | null; recipientId: string | null; email: string | null; name?: string | null };
  ipAddress: string | null;
  userAgent: string | null;
  data: unknown;
  prevHash: string;
  eventHash: string;
  signature: string;
  signedByKeyId: string;
}

interface Manifest {
  version: number;
  generator: string;
  envelope: { id: string; orgId: string; title: string; sentAt: string | null; completedAt: string | null };
  signedBy: { keyId: string; fingerprint: string; algorithm: string; publicKeyPem: string };
  documents: { itemOrder: number; title: string; sourceSha256: string; pageCount: number }[];
  recipients: { id: string; name: string; email: string; role: string; signingOrder: number; signingStatus: string; signedAt: string | null }[];
  auditChain: { head: string | null; length: number; events: ManifestEvent[] };
  manifestSha256: string;
  manifestSignature: string;
}

const GENESIS_PREV_HASH = '0'.repeat(64);

class VerifyError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) {
    console.error('Usage: verify <sealed.pdf>');
    process.exit(2);
  }
  const path = resolve(argv[0]!);
  if (!existsSync(path)) {
    console.error(`File not found: ${path}`);
    process.exit(2);
  }

  const bytes = readFileSync(path);
  const pdfSha256 = createHash('sha256').update(bytes).digest('hex');

  console.log('DocuRidge audit verification');
  console.log(`  file:        ${path}`);
  console.log(`  size:        ${bytes.length} bytes`);
  console.log(`  pdf sha256:  ${pdfSha256}`);

  let manifest: Manifest;
  try {
    manifest = await extractManifest(bytes);
  } catch (err) {
    fail('No DocuRidge manifest embedded in this PDF.', 'no_manifest');
  }
  console.log('');
  console.log(`  envelope:    ${manifest!.envelope.title} (${manifest!.envelope.id})`);
  console.log(`  signed by:   ${manifest!.signedBy.fingerprint} (${manifest!.signedBy.algorithm})`);
  console.log(`  documents:   ${manifest!.documents.length}`);
  console.log(`  recipients:  ${manifest!.recipients.length}`);
  console.log(`  events:      ${manifest!.auditChain.length}`);
  console.log('');

  const publicKey = publicKeyFromPem(manifest!.signedBy.publicKeyPem);

  // 1. Manifest content hash + signature.
  const reportedSha = manifest!.manifestSha256;
  const reportedSig = manifest!.manifestSignature;
  const recomputedSha = await sha256Hex(canonicalJson({ ...manifest!, manifestSha256: undefined, manifestSignature: undefined }));
  if (recomputedSha !== reportedSha) {
    fail(`Manifest content hash mismatch.\n  reported: ${reportedSha}\n  recomputed: ${recomputedSha}`, 'manifest_hash');
  }
  console.log('  ✓ manifest content hash matches');

  const manifestSigOk = await verifyHexSignature({
    publicKey,
    hexHash: reportedSha,
    hexSignature: reportedSig,
  });
  if (!manifestSigOk) {
    fail('Manifest signature is invalid.', 'manifest_signature');
  }
  console.log('  ✓ manifest signature verified');

  // 2. Audit chain integrity + signatures.
  let prev = GENESIS_PREV_HASH;
  for (const e of manifest!.auditChain.events) {
    if (e.prevHash !== prev) {
      fail(`Chain broken at seq ${e.seq}: prevHash mismatch.\n  expected ${prev}\n  got      ${e.prevHash}`, 'chain_prev_hash');
    }
    const body = {
      envelopeId: manifest!.envelope.id,
      seq: e.seq,
      type: e.type,
      actorUserId: e.actor.userId ?? null,
      actorRecipientId: e.actor.recipientId ?? null,
      actorEmail: e.actor.email ?? null,
      actorName: e.actor.name ?? null,
      ipAddress: e.ipAddress ?? null,
      userAgent: e.userAgent ?? null,
      data: e.data ?? null,
      prevHash: e.prevHash,
    };
    const expectedHash = await sha256Hex(canonicalJson(body));
    if (expectedHash !== e.eventHash) {
      fail(`Event ${e.seq} (${e.type}) eventHash mismatch.\n  expected ${expectedHash}\n  got      ${e.eventHash}`, 'event_hash');
    }
    if (!e.signature) {
      fail(`Event ${e.seq} (${e.type}) is unsigned.`, 'event_unsigned');
    }
    const sigOk = await verifyHexSignature({
      publicKey,
      hexHash: e.eventHash,
      hexSignature: e.signature,
    });
    if (!sigOk) {
      fail(`Event ${e.seq} (${e.type}) signature is invalid.`, 'event_signature');
    }
    prev = e.eventHash;
  }
  console.log(`  ✓ ${manifest!.auditChain.length} audit event hash(es) verified`);
  console.log(`  ✓ ${manifest!.auditChain.length} audit event signature(s) verified`);

  // 3. Chain head consistency.
  if (manifest!.auditChain.head && manifest!.auditChain.head !== prev) {
    fail(`Chain head mismatch: declared ${manifest!.auditChain.head}, computed ${prev}`, 'chain_head');
  }
  console.log('  ✓ chain head matches declared head');

  console.log('');
  console.log('VERIFY OK');
  process.exit(0);
}

function fail(message: string, code: string): never {
  console.error('');
  console.error('VERIFY FAILED');
  console.error(`  reason: ${message}`);
  console.error(`  code:   ${code}`);
  process.exit(1);
}

// ─── Manifest extraction from PDF ────────────────────────────────────────
async function extractManifest(pdfBytes: Buffer): Promise<Manifest> {
  const doc = await PDFDocument.load(pdfBytes);
  const catalog = doc.catalog;
  const namesDict = catalog.lookup(PDFName.of('Names'), PDFDict);
  if (!namesDict) throw new VerifyError('No Names entry in PDF catalog', 'no_names');
  const embeddedFilesNameTree = namesDict.lookup(PDFName.of('EmbeddedFiles'), PDFDict);
  if (!embeddedFilesNameTree) throw new VerifyError('No EmbeddedFiles in PDF Names tree', 'no_embedded_files');

  // The Names tree's "Names" entry is an array alternating: [filename, FilespecDict, ...].
  // pdf-lib's typed APIs are restrictive here; using untyped access.
  const namesArrRef = embeddedFilesNameTree.get(PDFName.of('Names'));
  const namesArr: any = (namesArrRef && typeof (namesArrRef as any).asArray === 'function')
    ? (namesArrRef as any)
    : doc.context.lookup(namesArrRef as any);
  if (!namesArr || typeof namesArr.asArray !== 'function') {
    throw new VerifyError('Empty EmbeddedFiles tree', 'no_embedded_files');
  }
  const arr: any[] = namesArr.asArray();
  for (let i = 0; i < arr.length; i += 2) {
    const nameVal = arr[i];
    let filename: string | null = null;
    if (nameVal instanceof PDFHexString) {
      // PDF text strings can be UTF-16BE-encoded with a BOM. decodeText()
      // handles that; falling back to UTF-8 if it's a plain hex of ASCII.
      try {
        filename = (nameVal as any).decodeText?.() ?? null;
      } catch { /* fall through */ }
      if (filename === null || filename === '') {
        const raw = Buffer.from(nameVal.asBytes());
        filename = raw[0] === 0xfe && raw[1] === 0xff
          ? raw.slice(2).swap16().toString('utf16le')
          : raw.toString('utf8');
      }
    } else if (nameVal instanceof PDFString) {
      filename = nameVal.decodeText();
    } else if (nameVal && typeof nameVal.asString === 'function') {
      filename = nameVal.asString();
    }
    if (filename && filename.startsWith('docuridge-manifest')) {
      // Found it — fall through to extraction.
    } else {
      continue;
    }

    const filespec = arr[i + 1];
    const filespecDict: PDFDict | undefined =
      filespec instanceof PDFDict
        ? filespec
        : (doc.context.lookup(filespec) as PDFDict | undefined);
    if (!filespecDict) continue;
    const efDict = filespecDict.lookup(PDFName.of('EF'), PDFDict);
    if (!efDict) continue;
    const fStreamRef = efDict.get(PDFName.of('F'));
    let stream: PDFRawStream | undefined;
    if (fStreamRef instanceof PDFRawStream) {
      stream = fStreamRef;
    } else {
      const looked: any = doc.context.lookup(fStreamRef as any);
      if (looked instanceof PDFRawStream) stream = looked;
    }
    if (!stream) continue;
    const bytes = stream.contents;
    // pdf-lib stores the attachment uncompressed by default; if compressed,
    // the contents would be FlateDecode-encoded. We inspect for a magic JSON
    // start; if not, attempt inflate.
    let text = Buffer.from(bytes).toString('utf8');
    if (text.charAt(0) !== '{') {
      try {
        const zlib = require('node:zlib');
        text = zlib.inflateSync(Buffer.from(bytes)).toString('utf8');
      } catch {
        // give up
      }
    }
    return JSON.parse(text) as Manifest;
  }
  throw new VerifyError('docuridge-manifest.json not found in PDF attachments', 'manifest_missing');
}

// ─── Helpers ────────────────────────────────────────────────────────────
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(',')}}`;
}

async function sha256Hex(input: string): Promise<string> {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function publicKeyFromPem(pem: string): Uint8Array {
  const b64 = pem
    .split('\n')
    .filter((line) => line && !line.includes('-----'))
    .join('')
    .trim();
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 32) {
    throw new VerifyError(`Invalid Ed25519 public key length: ${buf.length}`, 'bad_pubkey');
  }
  return new Uint8Array(buf);
}

async function verifyHexSignature(args: {
  publicKey: Uint8Array;
  hexHash: string;
  hexSignature: string;
}): Promise<boolean> {
  try {
    return await ed.verifyAsync(
      hexToBytes(args.hexSignature),
      hexToBytes(args.hexHash),
      args.publicKey,
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex string must have even length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

main().catch((err) => {
  console.error('verify: unexpected error');
  console.error(err);
  process.exit(3);
});
