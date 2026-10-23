#!/usr/bin/env tsx
/**
 * DocuRidge — verify command.
 *
 * Usage:
 *   npm run verify -- [--strict] [--allow-legacy-manifest] (--fingerprint <sha256> | --key <org-public-key.pem>) <sealed.pdf>
 *
 * Trust anchor (required for a passing result). The manifest inside the PDF
 * names the key that signed it, but anyone can re-sign a forged PDF with their
 * own key, so the key must come from somewhere else:
 *   --fingerprint <hex>   the org's signing-key SHA-256 fingerprint (repeatable)
 *   --key <file>          a file holding the org's public key PEM block(s)
 *   DOCURIDGE_VERIFY_FINGERPRINT / DOCURIDGE_VERIFY_KEY_FILE   env equivalents,
 *                         used when neither flag is given (comma-separated
 *                         fingerprints allowed)
 *
 * Reads the embedded `docuridge-manifest.json` from the sealed PDF, checks
 * that its signing key is the trusted one, walks the audit chain, recomputes
 * every event hash, verifies every signature, and recomputes the per-page
 * sealed-content digest with the digest version the manifest declares.
 * The checks live in src/lib/verify/sealed-pdf.ts. It never consults the
 * database.
 *
 * A legacy (v1) manifest has no page-content digest, so it proves nothing
 * about the document body: one lifted from any genuine old PDF onto a forged
 * body passes every other check. That result exits 5 unless the caller opts
 * in with --allow-legacy-manifest (then exit 0, labelled LEGACY MANIFEST).
 *
 * Exit codes:
 *   0  VERIFY OK — every check passed against a trusted key
 *   1  VERIFY FAILED — tampering or a key mismatch; `code:` names which check
 *   2  usage error (bad arguments, unreadable key file)
 *   3  unexpected error
 *   4  VERIFY UNTRUSTED — checks passed, but only against the key embedded in
 *      the document because no trusted key was supplied
 *   5  VERIFY INCOMPLETE — legacy (v1) manifest: audit chain verified against a
 *      trusted key, document body NOT covered; pass --allow-legacy-manifest to
 *      accept it with exit 0
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  normalizeFingerprint,
  parsePublicKeyFile,
  verifySealedPdf,
  type TrustAnchors,
} from '../src/lib/verify/sealed-pdf';

const USAGE =
  'Usage: verify [--strict] [--allow-legacy-manifest] (--fingerprint <sha256> | --key <org-public-key.pem>) <sealed.pdf>';

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(USAGE);
  process.exit(2);
}

interface Args {
  strict: boolean;
  allowLegacyManifest: boolean;
  path: string;
  trust?: TrustAnchors;
}

function parseArgs(argv: string[]): Args {
  let strict = false;
  let allowLegacyManifest = false;
  const keyFiles: string[] = [];
  const fingerprints: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--strict') strict = true;
    else if (arg === '--allow-legacy-manifest') allowLegacyManifest = true;
    else if (arg === '--key' || arg === '--fingerprint') {
      const value = argv[++i];
      if (!value) usage(`${arg} needs a value.`);
      (arg === '--key' ? keyFiles : fingerprints).push(value);
    } else if (arg.startsWith('--')) usage(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  if (positional.length !== 1) usage();

  const sources: string[] = [];
  if (keyFiles.length === 0 && fingerprints.length === 0) {
    const envKey = process.env.DOCURIDGE_VERIFY_KEY_FILE?.trim();
    const envFp = process.env.DOCURIDGE_VERIFY_FINGERPRINT?.trim();
    if (envKey) {
      keyFiles.push(envKey);
      sources.push('DOCURIDGE_VERIFY_KEY_FILE');
    }
    if (envFp) {
      fingerprints.push(...envFp.split(',').filter((f) => f.trim()));
      sources.push('DOCURIDGE_VERIFY_FINGERPRINT');
    }
  } else {
    if (fingerprints.length) sources.push('--fingerprint');
    for (const f of keyFiles) sources.push(`--key ${f}`);
  }
  if (keyFiles.length === 0 && fingerprints.length === 0) return { strict, allowLegacyManifest, path: positional[0]! };

  const trust: TrustAnchors = { publicKeys: [], fingerprints: [], source: sources.join(', ') };
  try {
    for (const fp of fingerprints) trust.fingerprints.push(normalizeFingerprint(fp));
    for (const file of keyFiles) trust.publicKeys.push(...parsePublicKeyFile(readFileSync(resolve(file), 'utf8')));
  } catch (err) {
    usage(err instanceof Error ? err.message : String(err));
  }
  return { strict, allowLegacyManifest, path: positional[0]!, trust };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const path = resolve(args.path);
  if (!existsSync(path)) {
    console.error(`File not found: ${path}`);
    process.exit(2);
  }

  const bytes = readFileSync(path);
  const pdfSha256 = createHash('sha256').update(bytes).digest('hex');

  console.log('DocuRidge audit verification');
  console.log(`  file:        ${path}`);
  console.log(`  size:        ${bytes.length} bytes`);
  console.log(`  file sha256 (informational, not verified): ${pdfSha256}`);
  console.log(`  trusted key: ${args.trust ? args.trust.source : 'NONE SUPPLIED — signatures can only be checked against the key inside the document'}`);

  const result = await verifySealedPdf(bytes, { strict: args.strict, trust: args.trust });
  const manifest = result.manifest;
  if (manifest) {
    console.log('');
    console.log(`  envelope:    ${manifest.envelope.title} (${manifest.envelope.id})`);
    console.log(`  signed by:   ${result.embeddedFingerprint ?? manifest.signedBy.fingerprint} (${manifest.signedBy.algorithm})`);
    console.log(`  documents:   ${manifest.documents.length}`);
    console.log(`  recipients:  ${manifest.recipients.length}`);
    console.log(`  events:      ${manifest.auditChain.length}`);
    console.log('');
  }
  for (const check of result.checks) console.log(`  ✓ ${check}`);

  if (!result.ok) {
    console.error('');
    console.error('VERIFY FAILED');
    console.error(`  reason: ${result.reason}`);
    console.error(`  code:   ${result.code}`);
    process.exit(1);
  }

  if (result.legacyManifest) {
    console.log('');
    console.log('  ──────────────────────────────────────────────────────────');
    console.log('  WARNING: legacy (v1) manifest — the audit chain above is');
    console.log('  verified, but this manifest carries no page-content digest,');
    console.log('  so the document BODY is NOT covered by this verification.');
    console.log('  Re-seal this envelope to gain body-tamper protection.');
    console.log('  ──────────────────────────────────────────────────────────');
  } else if (result.legacyDigest) {
    console.log('');
    console.log('  ──────────────────────────────────────────────────────────');
    console.log('  WARNING: sealed-content digest version 1 — page content');
    console.log('  streams are verified, but nested images and fonts, stream');
    console.log('  dictionaries, annotations, page boxes and /Rotate are NOT');
    console.log('  covered. Edits there would not be detected.');
    console.log('  ──────────────────────────────────────────────────────────');
  }

  if (!result.keyTrusted) {
    console.log('');
    console.log('  ──────────────────────────────────────────────────────────');
    console.log('  UNTRUSTED: no trusted key was supplied, so the signatures');
    console.log('  above were checked against the public key embedded in this');
    console.log('  PDF. Anyone can re-sign an altered PDF with their own key');
    console.log('  and pass every check above. Obtain the org\'s signing-key');
    console.log('  fingerprint from the org through a channel you trust and');
    console.log('  re-run with --fingerprint <fingerprint> (or --key <file>).');
    console.log(`  Key embedded in this document: ${result.embeddedFingerprint}`);
    console.log('  ──────────────────────────────────────────────────────────');
    console.log('');
    console.log('VERIFY UNTRUSTED — key taken from the document; authenticity NOT established');
    process.exit(4);
  }

  console.log('');
  if (result.legacyManifest && !args.allowLegacyManifest) {
    console.log('VERIFY INCOMPLETE — LEGACY MANIFEST (v1): audit chain verified, document body NOT covered.');
    console.log('  A v1 manifest copied from any genuine sealed PDF onto a forged body passes');
    console.log('  every check above. Re-run with --allow-legacy-manifest to accept it anyway.');
    process.exit(5);
  }
  if (result.legacyManifest) {
    console.log('VERIFY OK — LEGACY MANIFEST (v1): audit chain verified, document body NOT covered');
  } else if (result.legacyDigest) {
    console.log('VERIFY OK — LEGACY DIGEST (v1): audit chain and page content streams verified, nested resources/annotations/page boxes NOT covered');
  } else {
    console.log('VERIFY OK');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('verify: unexpected error');
  console.error(err);
  process.exit(3);
});
