/**
 * Seed script. Phase 1 ships an empty seed; Phase 7 fills it with realistic
 * demo data (3 users across 2 roles, 6 envelopes covering every lifecycle
 * state, 3 templates, sample sealed PDF). The bootstrap admin row is created
 * by the docker entrypoint, NOT here.
 */

async function main(): Promise<void> {
  console.log('seed: no-op (Phase 1). Demo data ships in Phase 7.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
