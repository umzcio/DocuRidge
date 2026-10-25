/**
 * Offline verification of a DocuRidge sealed PDF: the logic behind
 * `npm run verify` (scripts/verify.ts is the CLI wrapper).
 *
 * Checks the file is a single revision whose cross-reference table resolves
 * every object to its one definition (pdf-structure.ts), so pdf-lib's view
 * is the viewer's. Then reads the embedded `docuridge-manifest.json`, checks the manifest hash and
 * signature, walks the audit chain (event hashes, signatures, head), and
 * recomputes the per-page sealed-content digest with the version the
 * manifest declares. It never consults the database.
 *
 * Every check above is relative to the public key in `signedBy`, which
 * comes from the PDF under test: a forger can re-sign an altered document
 * with a fresh key and pass all of them. Authenticity therefore needs a
 * trust anchor obtained independently of the PDF (`options.trust`: the org's
 * public key or its SHA-256 fingerprint). Without one, `keyTrusted` is false
 * and callers must not report the document as verified.
 */

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import {
  GENESIS_PREV_HASH,
  canonicalJson,
  hashAuditEventBody,
  publicKeyFromPem,
  sha256Hex,
  verifyHexSignature,
} from '../audit/canonical';
import {
  CURRENT_SEALED_CONTENT_DIGEST_VERSION,
  SUPPORTED_SEALED_CONTENT_DIGEST_VERSIONS,
  SealedContentStructureError,
  sealedContentDigestFromBytes,
  sealedContentDigestVersion,
  type SealedContentDigest,
  type SealedContentDigestVersion,
} from '../pdf/content-digest';
import { PdfDecodeLimitError, loadPdfWithDecodeLimits } from '../pdf/decode-limits';
import { MAX_PAGES as SEALED_MAX_PAGES, sealedMaxParseObjects } from '../pdf/page-tree';

// The sealed-PDF parse-object ceiling (envelope seal-object cap plus this
// headroom), separate from PDF_MAX_PARSE_OBJECTS for source uploads.
export { SEALED_PARSE_OBJECT_HEADROOM, sealedMaxParseObjects } from '../pdf/page-tree';
import { PdfComplexityError } from '../pdf/seal-limits';
import {
  MANIFEST_ATTACHMENT_NAME,
  catalogAssociatedFiles,
  decodePdfText,
  isSameObject,
  listEmbeddedFiles,
  manifestEntryIndex,
  type EmbeddedFileEntry,
  type EmbeddedFiles,
} from '../pdf/embedded-files';
import { PdfStructureError, checkPdfStructure } from './pdf-structure';

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

/** Keys the relying party trusts, obtained out of band (never from the PDF). */
export interface TrustAnchors {
  publicKeys: Uint8Array[];
  /** Lower-case hex SHA-256 of the raw 32-byte Ed25519 public key. */
  fingerprints: string[];
  /** Where the anchors came from, for the report (e.g. "--key org.pem"). */
  source: string;
}

export interface VerifyOptions {
  /** Refuse manifests and digests that do not cover the whole document body. */
  strict?: boolean;
  trust?: TrustAnchors;
  /** Parse-object ceiling for the file; default `sealedMaxParseObjects()`. */
  maxParseObjects?: number;
}

export const UNTRUSTED_KEY_SOURCE = 'embedded in the document (untrusted)';

/** Fingerprint as the app computes it: sha256 of the raw public key, hex. */
export function fingerprintOf(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest('hex');
}

export function normalizeFingerprint(input: string): string {
  const fp = input.replace(/[\s:]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fp)) {
    throw new Error(`Invalid key fingerprint "${input}": expected 64 hex characters (SHA-256).`);
  }
  return fp;
}

/** Every DocuRidge Ed25519 PEM block in a key file (a file may list rotated keys). */
export function parsePublicKeyFile(contents: string): Uint8Array[] {
  const blocks = contents.match(/-----BEGIN [A-Z0-9 ]*PUBLIC KEY-----[\s\S]*?-----END [A-Z0-9 ]*PUBLIC KEY-----/g) ?? [];
  if (blocks.length === 0) throw new Error('Key file contains no PEM public key block.');
  return blocks.map((block) => publicKeyFromPem(block));
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
  /**
   * Digest older than the current version (see `digestVersion`). Version 1
   * covers page content streams only; version 2 covers each page's whole
   * graph but signs neither the page tree nor the attachment set (this
   * verifier still checks both structurally for every version).
   */
  legacyDigest: boolean;
  /** True only when the signing key matched a trust anchor supplied by the caller. */
  keyTrusted: boolean;
  /** Where the key the signatures were checked against came from. */
  keySource: string;
  /** Fingerprint computed from the key embedded in the manifest. */
  embeddedFingerprint?: string;
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
  const result: VerifyResult = {
    ok: false,
    checks: [],
    legacyManifest: false,
    legacyDigest: false,
    keyTrusted: false,
    keySource: UNTRUSTED_KEY_SOURCE,
  };
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
    } else if (err instanceof PdfComplexityError && err.limit === 'parse_objects') {
      result.code = 'sealed_content_too_complex';
      result.reason = `The file holds more objects than a sealed PDF may (${err.message}).`;
    } else {
      throw err;
    }
  }
  return result;
}

async function runChecks(bytes: Uint8Array, options: VerifyOptions, result: VerifyResult): Promise<void> {
  // 0. File structure, before anything is read through pdf-lib: one revision,
  //    one definition per object, resolved by the xref the way viewers do.
  const maxParseObjects = options.maxParseObjects ?? sealedMaxParseObjects();
  try {
    await checkPdfStructure(bytes, { maxParseObjects });
  } catch (err) {
    if (err instanceof PdfStructureError) fail(err.message, err.code);
    throw err;
  }
  result.checks.push('single revision; every object defined once, where the cross-reference table says');

  let doc: PDFDocument;
  try {
    doc = await loadPdfWithDecodeLimits(bytes, {
      ignoreEncryption: true,
      maxPages: SEALED_MAX_PAGES,
      maxParseObjects,
      pageTreeMode: 'sealed',
    });
  } catch (err) {
    if (err instanceof PdfDecodeLimitError) throw err;
    if (err instanceof PdfComplexityError && err.limit === 'parse_objects') throw err;
    if (err instanceof SealedContentStructureError) fail(err.message, err.code);
    if (err instanceof PdfComplexityError && err.limit === 'pages') fail(err.message, 'sealed_content_page_tree');
    fail('No DocuRidge manifest embedded in this PDF.', 'no_manifest');
  }
  const attachments = listEmbeddedFiles(doc);
  const manifestIndex = manifestEntryIndex(attachments.entries);
  if (manifestIndex === -2) {
    fail(
      `More than one attachment is named ${MANIFEST_ATTACHMENT_NAME}; a sealed PDF has exactly one, so a second was added after sealing.`,
      'manifest_ambiguous',
    );
  }
  let manifest: Manifest;
  try {
    manifest = readManifestAttachment(attachments.entries[manifestIndex]);
  } catch (err) {
    if (err instanceof PdfDecodeLimitError) throw err;
    fail('No DocuRidge manifest embedded in this PDF.', 'no_manifest');
  }
  result.manifest = manifest;

  let publicKey: Uint8Array;
  try {
    publicKey = publicKeyFromPem(manifest.signedBy.publicKeyPem);
  } catch {
    fail('Manifest carries no valid Ed25519 public key.', 'bad_public_key');
  }
  const embeddedFingerprint = fingerprintOf(publicKey);
  result.embeddedFingerprint = embeddedFingerprint;
  if (String(manifest.signedBy.fingerprint).toLowerCase() !== embeddedFingerprint) {
    fail(
      `Manifest signedBy.fingerprint does not match its embedded public key.\n  declared ${manifest.signedBy.fingerprint}\n  computed ${embeddedFingerprint}`,
      'fingerprint_mismatch',
    );
  }

  // 0. Trust anchor: the embedded key must be one the caller already trusts.
  if (options.trust) {
    const trusted =
      options.trust.fingerprints.includes(embeddedFingerprint) ||
      options.trust.publicKeys.some((k) => Buffer.from(k).equals(Buffer.from(publicKey)));
    if (!trusted) {
      fail(
        `This document was signed by key ${embeddedFingerprint}, which is not the trusted key (${options.trust.source}).`,
        'untrusted_key',
      );
    }
    result.keyTrusted = true;
    result.keySource = options.trust.source;
    result.checks.push(`signing key ${embeddedFingerprint} matches the trusted key (${options.trust.source})`);
  }

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

  // 4. Attachments: the seal attaches the manifest and nothing else, for
  //    every version (v3 also signs the rest of the set, which must be empty).
  checkAttachments(doc, attachments, manifestIndex);
  result.checks.push(`${MANIFEST_ATTACHMENT_NAME} is the only embedded file`);

  // 5. Sealed page-content digest, recomputed with the version it was sealed with.
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
  let recomputed: SealedContentDigest;
  try {
    recomputed = await sealedContentDigestFromBytes(bytes, version as SealedContentDigestVersion);
  } catch (err) {
    if (err instanceof SealedContentStructureError) fail(err.message, err.code);
    throw err;
  }
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
  if (version < CURRENT_SEALED_CONTENT_DIGEST_VERSION) {
    if (options.strict) {
      fail(
        version === 1
          ? `Sealed-content digest version 1 covers page content streams only, not nested resources, annotations, page boxes or the page tree; --strict requires version ${CURRENT_SEALED_CONTENT_DIGEST_VERSION}.`
          : `Sealed-content digest version ${version} does not sign the page tree or the attachment set; --strict requires version ${CURRENT_SEALED_CONTENT_DIGEST_VERSION}.`,
        'sealed_content_legacy_digest',
      );
    }
    result.legacyDigest = true;
  }
}

// ─── Manifest attachment ─────────────────────────────────────────────────

/** File specification keys pdf-lib's attach() writes for the manifest. */
const MANIFEST_FILESPEC_KEYS = new Set(['/Type', '/F', '/UF', '/EF', '/Desc', '/AFRelationship']);

/** Parse the manifest JSON out of its name-tree entry (see embedded-files.ts for which entry). */
function readManifestAttachment(entry: EmbeddedFileEntry | undefined): Manifest {
  if (!entry?.filespec) throw new Error(`${MANIFEST_ATTACHMENT_NAME} not found in PDF attachments`);
  const ef = entry.filespec.lookup(PDFName.of('EF'));
  if (!(ef instanceof PDFDict)) throw new Error('manifest attachment has no /EF');
  const stream = ef.lookup(PDFName.of('F'));
  if (!(stream instanceof PDFRawStream)) throw new Error('manifest attachment has no embedded file stream');
  const bytes = stream.contents;
  // pdf-lib's attach() FlateDecode-compresses the file; accept plain JSON too.
  let text = Buffer.from(bytes).toString('utf8');
  if (text.charAt(0) !== '{') {
    try {
      text = inflateSync(Buffer.from(bytes), { maxOutputLength: MAX_MANIFEST_BYTES }).toString('utf8');
    } catch {
      // give up; JSON.parse below fails
    }
  }
  const manifest: unknown = JSON.parse(text);
  if (typeof manifest !== 'object' || manifest === null) throw new Error('manifest is not a JSON object');
  return manifest as Manifest;
}

/**
 * The seal attaches the manifest and nothing else. Refuse any other
 * `/Names /EmbeddedFiles` entry, any catalog `/AF` item other than the
 * manifest's file specification, and a manifest file specification that
 * carries anything besides the manifest stream (a second stream under
 * `/EF /UF`, related files, another display name), so no file can be added
 * after sealing or hidden behind the manifest.
 */
function checkAttachments(doc: PDFDocument, files: EmbeddedFiles, manifestIndex: number): void {
  const unexpected = (detail: string): never =>
    fail(`The PDF carries attachments the seal did not add: ${detail}.`, 'unexpected_attachment');
  if (files.malformed) unexpected('the /EmbeddedFiles name tree is malformed');
  const others = files.entries.filter((_, i) => i !== manifestIndex);
  if (others.length > 0) unexpected(others.map((e) => JSON.stringify(e.name ?? '(unnamed)')).join(', '));
  const filespec = files.entries[manifestIndex]!.filespec!;
  const af = catalogAssociatedFiles(doc);
  if (af && (af.malformed || af.items.length > 1 || af.items.some((item) => !isSameObject(doc, item, filespec)))) {
    unexpected('the catalog /AF lists a file other than the manifest');
  }
  const extraKeys = filespec.keys().map((k) => k.asString()).filter((k) => !MANIFEST_FILESPEC_KEYS.has(k));
  if (extraKeys.length > 0) unexpected(`the manifest file specification has ${extraKeys.join(', ')}`);
  for (const key of ['F', 'UF']) {
    const name = filespec.get(PDFName.of(key));
    if (name !== undefined && decodePdfText(name) !== MANIFEST_ATTACHMENT_NAME) {
      unexpected(`the manifest file specification's /${key} names another file`);
    }
  }
  const efKeys = filespec.lookup(PDFName.of('EF'), PDFDict).keys().map((k) => k.asString());
  if (efKeys.length !== 1 || efKeys[0] !== '/F') unexpected(`the manifest file specification embeds ${efKeys.join(', ')}`);
}

/** Read the signed manifest from a sealed PDF (locates it; checks nothing else). */
export async function extractManifest(pdfBytes: Uint8Array): Promise<Manifest> {
  const doc = await loadPdfWithDecodeLimits(pdfBytes, {
    ignoreEncryption: true,
    maxPages: SEALED_MAX_PAGES,
    maxParseObjects: sealedMaxParseObjects(),
    pageTreeMode: 'sealed',
  });
  const { entries } = listEmbeddedFiles(doc);
  const index = manifestEntryIndex(entries);
  if (index === -2) throw new Error(`more than one attachment is named ${MANIFEST_ATTACHMENT_NAME}`);
  return readManifestAttachment(entries[index]);
}

