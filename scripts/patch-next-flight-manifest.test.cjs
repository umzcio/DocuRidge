const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { patchNextFlightManifest } = require('./patch-next-flight-manifest.cjs');

const targets = ['dist/build/webpack/plugins/flight-manifest-plugin.js', 'dist/esm/build/webpack/plugins/flight-manifest-plugin.js'];
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'next-flight-patch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '15.5.24' }));
  for (const target of targets) {
    const file = path.join(directory, target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'function record(concatenatedModId) { if (concatenatedModId) { return true; } return false; }');
  }
  return directory;
}

test('both patched builds record module zero, retain null rejection, and tolerate a second run', t => {
  const directory = fixture(t);
  patchNextFlightManifest(directory);
  patchNextFlightManifest(directory);
  for (const target of targets) {
    const source = fs.readFileSync(path.join(directory, target), 'utf8');
    assert.equal(vm.runInNewContext(`${source}; record(0)`), true);
    assert.equal(vm.runInNewContext(`${source}; record(null)`), false);
  }
});

test('an unexpected second target aborts before the first file changes', t => {
  const directory = fixture(t);
  const first = path.join(directory, targets[0]);
  const original = fs.readFileSync(first, 'utf8');
  fs.writeFileSync(path.join(directory, targets[1]), 'upstream implementation changed');
  assert.throws(() => patchNextFlightManifest(directory), /Unexpected.*predicate/);
  assert.equal(fs.readFileSync(first, 'utf8'), original);
});

test('a newer version with the known fix is accepted without rewriting files', t => {
  const directory = fixture(t);
  patchNextFlightManifest(directory);
  const before = targets.map(target => fs.readFileSync(path.join(directory, target), 'utf8'));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '15.5.25' }));
  assert.doesNotThrow(() => patchNextFlightManifest(directory));
  assert.deepEqual(targets.map(target => fs.readFileSync(path.join(directory, target), 'utf8')), before);
});
