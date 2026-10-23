const fs = require('node:fs');
const path = require('node:path');

// Next 15.5.24 drops concatenated client components assigned webpack ID 0.
// CorrectButton hit this in a production build: the browser chunk contained
// module 0, but its RSC client-reference manifest omitted the component.
// Keep the normal module-ID branch's null check in the concatenated branch too.
// Remove this workaround once the installed Next release includes the fix.
const broken = 'if (concatenatedModId) {';
const fixed = 'if (concatenatedModId !== null) {';
const targets = [
  'dist/build/webpack/plugins/flight-manifest-plugin.js',
  'dist/esm/build/webpack/plugins/flight-manifest-plugin.js',
];

function patchNextFlightManifest(nextDirectory) {
  const { version } = JSON.parse(fs.readFileSync(path.join(nextDirectory, 'package.json'), 'utf8'));
  // Validate both artifacts before writing either one. An upstream refactor
  // must be reviewed explicitly instead of silently skipping this build fix.
  const patches = targets.map(target => {
    const file = path.join(nextDirectory, target);
    const source = fs.readFileSync(file, 'utf8');
    const brokenCount = source.split(broken).length - 1;
    const fixedCount = source.split(fixed).length - 1;
    if (brokenCount === 0 && fixedCount === 1) return null;
    if (brokenCount !== 1 || fixedCount !== 0) {
      throw new Error(`Unexpected Next ${version} client manifest predicate in ${target}; review the module-ID-zero workaround before building.`);
    }
    if (version !== '15.5.24') {
      throw new Error(`Next ${version} still has the client manifest predicate bug, but this patch was verified against 15.5.24. Review it before building.`);
    }
    return { file, source: source.replace(broken, fixed) };
  }).filter(Boolean);
  for (const patch of patches) fs.writeFileSync(patch.file, patch.source);
  return patches.length;
}

if (require.main === module) {
  try {
    const directory = path.dirname(require.resolve('next/package.json'));
    const count = patchNextFlightManifest(directory);
    console.log(`[next-flight-manifest] ${count ? `Patched ${count} compiler artifacts to preserve client module ID 0.` : 'Client module ID 0 fix is already present.'}`);
  } catch (error) {
    console.error(`[next-flight-manifest] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

module.exports = { patchNextFlightManifest };
