/**
 * Entry for the canonical-documents backfill. esbuild bundles this (and
 * src/lib/ops/canonical-backfill.ts, where the logic and its tests live) into
 * dist/canonical-backfill.cjs; see DEPLOYMENT.md for the command.
 */
import { prisma } from '../src/lib/prisma';
import { main } from '../src/lib/ops/canonical-backfill';

main(process.argv.slice(2))
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async () => {
    // Fixed text: an exception's message may hold paths or SQL.
    process.stderr.write('canonical-backfill failed before it could report\n');
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
