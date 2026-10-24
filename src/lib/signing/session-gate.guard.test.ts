import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * `loadSigningSession` validates the token but knows nothing about access
 * codes. Request-facing code must go through `loadGatedSigningSession`
 * (session-gate.ts), which also demands the unlock proof, so a new route or
 * action cannot forget the second factor. This fails if anything outside the
 * gate (and lifecycle itself) imports the ungated loader.
 */

const SRC = path.resolve(__dirname, '../..');
const ALLOWED = new Set([
  path.join(SRC, 'lib/envelopes/lifecycle.ts'),
  path.join(SRC, 'lib/signing/session-gate.ts'),
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe('signing-session gate', () => {
  it('only the gate imports the ungated loadSigningSession', () => {
    const offenders = sourceFiles(SRC).filter((file) => {
      if (ALLOWED.has(file)) return false;
      const text = readFileSync(file, 'utf8');
      return /import\s*(?:type\s*)?\{[^}]*\bloadSigningSession\b[^}]*\}\s*from/.test(text)
        || /\bimport\(\s*['"][^'"]*envelopes\/lifecycle['"]\s*\)[^;]*loadSigningSession/.test(text);
    });
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
