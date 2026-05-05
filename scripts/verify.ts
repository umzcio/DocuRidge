#!/usr/bin/env tsx
/**
 * Verify command (Phase 4 stub).
 *
 * Usage: docker compose -p docuridge exec app npm run verify -- /path/to/sealed.pdf
 *
 * In Phase 4 this re-checks the audit chain end-to-end, the document hash,
 * and the embedded signed JSON manifest. For now it verifies file presence
 * and prints the pending implementation note.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) {
    console.error('Usage: verify <sealed.pdf>');
    process.exit(2);
  }
  const pathArg = resolve(argv[0]!);
  if (!existsSync(pathArg)) {
    console.error(`File not found: ${pathArg}`);
    process.exit(2);
  }
  console.log('verify: not implemented yet (Phase 4 — cryptographic hardening).');
  console.log('When implemented, this command will:');
  console.log('  1. Re-compute SHA-256 of the sealed PDF and match audit-chain head.');
  console.log('  2. Walk the audit chain, verifying prevHash + Ed25519 signatures.');
  console.log('  3. Extract and verify the embedded signed JSON manifest.');
  console.log('  4. Exit 0 on full match, non-zero on any tamper.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
