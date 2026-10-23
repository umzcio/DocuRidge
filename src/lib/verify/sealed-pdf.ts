/**
 * Offline verification of a DocuRidge sealed PDF: the logic behind
 * `npm run verify` (scripts/verify.ts is the CLI wrapper).
 *
 * Reads the embedded `docuridge-manifest.json`, checks the manifest hash and
 * signature, walks the audit chain (event hashes, signatures, head), and
 * recomputes the per-page sealed-content digest with the version the
 * manifest declares. It never consults the database.
 */

import { inflateSync } from 'node:zlib';
import { PDFDict, PDFHexString, PDFName, PDFRawStream, PDFString } from 'pdf-lib';
import {
  GENESIS_PREV_HASH,
  canonicalJson,
  hashAuditEventBody,
  publicKeyFromPem,
  sha256Hex,
  verifyHexSignature,
} from '../audit/canonical';
import {
  SUPPORTED_SEALED_CONTENT_DIGEST_VERSIONS,
  sealedContentDigestFromBytes,
  sealedContentDigestVersion,
  type SealedContentDigestVersion,
} from '../pdf/content-digest';
import { PdfDecodeLimitError, loadPdfWithDecodeLimits } from '../pdf/decode-limits';

/** A genuine manifest is tens of KB; refuse to inflate an attachment past this. */
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

export interface ManifestEvent {
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

export interface Manifest {
  version: number;
  generator: string;
  envelope: { id: string; orgId: string; title: string; sentAt: string | null; completedAt: string | null };
  signedBy: { keyId: string; fingerprint: string; algorithm: string; publicKeyPem: string };
  documents: { itemOrder: number; title: string; sourceSha256: string; pageCount: number }[];
  sealedContent?: { algorithm: string; digestVersion?: number; pageCount: number; pageDigests: string[] };
  recipients: { id: string; name: string; email: string; role: string; signingOrder: number; signingStatus: string; signedAt: string | null }[];
  auditChain: { head: string | null; length: number; events: ManifestEvent[] };
  manifestSha256: string;
  manifestSignature: string;
}

export interface VerifyOptions {
  /** Refuse manifests and digests that do not cover the whole document body. */
  strict?: boolean;
}

export interface VerifyResult {
  ok: boolean;
  /** Failure code (stable, documented in README/SECURITY.md). */
  code?: string;
  reason?: string;
  manifest?: Manifest;
  /** Progress lines for each check that passed, in order. */
  checks: string[];
  /** Sealed-content digest version checked; undefined for a v1 manifest without one. */
  digestVersion?: number;
  /** v1 manifest: no page-content digest at all. */
  legacyManifest: boolean;
  /** Digest version 1: page content streams only, not nested resources/annotations/boxes. */
  legacyDigest: boolean;
}

class VerifyFailure extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

function fail(message: string, code: string): never {
  throw new VerifyFailure(message, code);
}

export async function verifySealedPdf(bytes: Uint8Array, options: VerifyOptions = {}): Promise<VerifyResult> {
  const result: VerifyResult = { ok: false, checks: [], legacyManifest: false, legacyDigest: false };
  try {
    await runChecks(bytes, options, result);
    result.ok = true;
  } catch (err) {
    if (err instanceof VerifyFailure) {
      result.code = err.code;
      result.reason = err.message;
    } else if (err instanceof PdfDecodeLimitError) {
      result.code = 'decode_limit';
      result.reason = `PDF exceeds the decode limits: ${err.message}`;
    } else {
      throw err;
    }
  }
  return result;
}

async function runChecks(bytes: Uint8Array, options: VerifyOptions, result: VerifyResult): Promise<void> {
  let manifest: Manifest;
  try {
    manifest = await extractManifest(bytes);
  } catch (err) {
    if (err instanceof PdfDecodeLimitError) throw err;
    fail('No DocuRidge manifest embedded in this PDF.', 'no_manifest');
  }
  result.manifest = manifest;

  const publicKey = publicKeyFromPem(manifest.signedBy.publicKeyPem);

  // 1. Manifest content hash + signature.
  const reportedSha = manifest.manifestSha256;
  const recomputedSha = await sha256Hex(canonicalJson({ ...manifest, manifestSha256: undefined, manifestSignature: undefined }));
  if (recomputedSha !== reportedSha) {
    fail(`Manifest content hash mismatch.\n  reported: ${reportedSha}\n  recomputed: ${recomputedSha}`, 'manifest_hash');
  }
  result.checks.push('manifest content hash matches');

  const manifestSigOk = await verifyHexSignature({ publicKey, hexHash: reportedSha, hexSignature: manifest.manifestSignature });
  if (!manifestSigOk) fail('Manifest signature is invalid.', 'manifest_signature');
  result.checks.push('manifest signature verified');

  // 2. Audit chain integrity + signatures.
  let prev = GENESIS_PREV_HASH;
  for (const e of manifest.auditChain.events) {
    if (e.prevHash !== prev) {
      fail(`Chain broken at seq ${e.seq}: prevHash mismatch.\n  expected ${prev}\n  got      ${e.prevHash}`, 'chain_prev_hash');
    }
    const expectedHash = await hashAuditEventBody({
      envelopeId: manifest.envelope.id,
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
    });
    if (expectedHash !== e.eventHash) {
      fail(`Event ${e.seq} (${e.type}) eventHash mismatch.\n  expected ${expectedHash}\n  got      ${e.eventHash}`, 'event_hash');
    }
    if (!e.signature) fail(`Event ${e.seq} (${e.type}) is unsigned.`, 'event_unsigned');
    const sigOk = await verifyHexSignature({ publicKey, hexHash: e.eventHash, hexSignature: e.signature });
    if (!sigOk) fail(`Event ${e.seq} (${e.type}) signature is invalid.`, 'event_signature');
    prev = e.eventHash;
  }
  result.checks.push(`${manifest.auditChain.length} audit event hash(es) verified`);
  result.checks.push(`${manifest.auditChain.length} audit event signature(s) verified`);

  // 3. Chain head consistency.
  if (manifest.auditChain.head && manifest.auditChain.head !== prev) {
    fail(`Chain head mismatch: declared ${manifest.auditChain.head}, computed ${prev}`, 'chain_head');
  }
  result.checks.push('chain head matches declared head');

  // 4. Sealed page-content digest, recomputed with the version it was sealed with.
  const declared = manifest.sealedContent;
  if (!declared) {
    if (options.strict) {
      fail('Manifest predates page-content binding (version 1); --strict requires a v2+ manifest.', 'sealed_content_missing');
    }
    result.legacyManifest = true;
    return;
  }
  const version = sealedContentDigestVersion(declared);
  if (!SUPPORTED_SEALED_CONTENT_DIGEST_VERSIONS.includes(version)) {
    fail(`Unsupported sealed-content digest version ${String(declared.digestVersion)}; upgrade the verifier.`, 'sealed_content_version');
  }
  result.digestVersion = version;
  const recomputed = await sealedContentDigestFromBytes(bytes, version as SealedContentDigestVersion);
  if (recomputed.pageCount !== declared.pageCount) {
    fail(`Sealed content page count mismatch.\n  expected ${declared.pageCount}\n  got      ${recomputed.pageCount}`, 'sealed_content_pages');
  }
  for (let i = 0; i < declared.pageDigests.length; i++) {
    const expected = declared.pageDigests[i]!;
    const got = recomputed.pageDigests[i]!;
    if (expected !== got) {
      fail(`Page ${i + 1} content digest mismatch.\n  expected ${expected}\n  got      ${got}`, 'sealed_content_digest');
    }
  }
  result.checks.push(`${declared.pageDigests.length} page content digest(s) verified (digest version ${version})`);
  if (version === 1) {
    if (options.strict) {
      fail(
        'Sealed-content digest version 1 covers page content streams only, not nested resources, annotations or page boxes; --strict requires version 2.',
        'sealed_content_legacy_digest',
      );
    }
    result.legacyDigest = true;
  }
}

// ─── Manifest extraction from PDF ────────────────────────────────────────
export async function extractManifest(pdfBytes: Uint8Array): Promise<Manifest> {
  const doc = await loadPdfWithDecodeLimits(pdfBytes, { ignoreEncryption: true });
  const catalog = doc.catalog;
  const namesDict = catalog.lookup(PDFName.of('Names'), PDFDict);
  if (!namesDict) throw new Error('No Names entry in PDF catalog');
  const embeddedFilesNameTree = namesDict.lookup(PDFName.of('EmbeddedFiles'), PDFDict);
  if (!embeddedFilesNameTree) throw new Error('No EmbeddedFiles in PDF Names tree');

  // The Names tree's "Names" entry is an array alternating: [filename, FilespecDict, ...].
  // pdf-lib's typed APIs are restrictive here; using untyped access.
  const namesArrRef = embeddedFilesNameTree.get(PDFName.of('Names'));
  const namesArr: any = (namesArrRef && typeof (namesArrRef as any).asArray === 'function')
    ? (namesArrRef as any)
    : doc.context.lookup(namesArrRef as any);
  if (!namesArr || typeof namesArr.asArray !== 'function') {
    throw new Error('Empty EmbeddedFiles tree');
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
    if (!filename || !filename.startsWith('docuridge-manifest')) continue;

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
    // start; if not, attempt a bounded inflate.
    let text = Buffer.from(bytes).toString('utf8');
    if (text.charAt(0) !== '{') {
      try {
        text = inflateSync(Buffer.from(bytes), { maxOutputLength: MAX_MANIFEST_BYTES }).toString('utf8');
      } catch {
        // give up
      }
    }
    return JSON.parse(text) as Manifest;
  }
  throw new Error('docuridge-manifest.json not found in PDF attachments');
}
