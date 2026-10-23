#!/usr/bin/env tsx
/**
 * DocuRidge — verify command.
 *
 * Usage:
 *   docker compose -p docuridge exec app npm run verify -- [--strict] <sealed.pdf>
 *
 * Reads the embedded `docuridge-manifest.json` from the sealed PDF, walks the
 * audit chain, recomputes every event hash, verifies every signature, and
 * recomputes the per-page sealed-content digest with the digest version the
 * manifest declares. Exits 0 on full pass, non-zero with a diagnostic message
 * on any tamper. The checks live in src/lib/verify/sealed-pdf.ts.
 *
 * The verifier is INTENTIONALLY self-contained — it does not consult the
 * database.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { verifySealedPdf } from '../src/lib/verify/sealed-pdf';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const positional = argv.filter((a) => a !== '--strict');
  if (positional.length !== 1) {
    console.error('Usage: verify [--strict] <sealed.pdf>');
    process.exit(2);
  }
  const path = resolve(positional[0]!);
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

  const result = await verifySealedPdf(bytes, { strict });
  const manifest = result.manifest;
  if (manifest) {
    console.log('');
    console.log(`  envelope:    ${manifest.envelope.title} (${manifest.envelope.id})`);
    console.log(`  signed by:   ${manifest.signedBy.fingerprint} (${manifest.signedBy.algorithm})`);
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

  console.log('');
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
