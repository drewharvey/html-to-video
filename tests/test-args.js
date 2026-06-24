#!/usr/bin/env node
//
// Argument-parser & input-discovery error-path tests. These are the exit-2
// (usage) and exit-1 (input) failures in parseArgs / parse* helpers /
// discoverInputs — the boilerplate that new flags get pattern-matched into,
// previously unguarded. All are pre-browser, so they're fast.
//
//   node tests/test-args.js
//   npm run test:args

const fs = require('fs');
const path = require('path');
const { scenario, assert, assertEq, runH2v, summary } = require('./_test-harness');

console.log('test-args.js — parser & discovery error paths');
console.log('');

// --- usage errors (exit 2), no file needed: parseArgs exits before main ---

scenario('unknown command → exit 2', () => {
  assertEq(runH2v(['frobnicate']).code, 2, 'exit code');
});

scenario('unknown flag → exit 2', () => {
  assertEq(runH2v(['export', '--bogus']).code, 2, 'exit code');
});

scenario('flag at end with no value → exit 2 (requires a value)', () => {
  const r = runH2v(['export', '--fps']);
  assertEq(r.code, 2, 'exit code');
  assert(/requires a value/.test(r.stderr), `stderr: ${r.stderr}`);
});

scenario('invalid --duration → exit 2', () => {
  assertEq(runH2v(['export', '--duration', 'abc']).code, 2, 'exit code');
});

scenario('--duration 0 → exit 2 (must be > 0)', () => {
  const r = runH2v(['export', '--duration', '0']);
  assertEq(r.code, 2, 'exit code');
  assert(/must be > 0/.test(r.stderr), `stderr: ${r.stderr}`);
});

scenario('non-integer --fps → exit 2', () => {
  assertEq(runH2v(['export', '--fps', '1.5']).code, 2, 'exit code');
});

scenario('zero --fps → exit 2 (positive integer)', () => {
  assertEq(runH2v(['export', '--fps', '0']).code, 2, 'exit code');
});

scenario('--crf out of [0..51] → exit 2', () => {
  assertEq(runH2v(['export', '--crf', '99']).code, 2, 'exit code');
});

scenario('invalid --capture-format → exit 2', () => {
  assertEq(runH2v(['export', '--capture-format', 'bmp']).code, 2, 'exit code');
});

scenario('invalid --alpha-mode → exit 2', () => {
  assertEq(runH2v(['export', '--alpha-mode', 'sideways']).code, 2, 'exit code');
});

// --- input-discovery errors (exit 1), need real paths ---

scenario('path not found → exit 1', () => {
  const r = runH2v(['export', '/no/such/file.html', '--dry-run']);
  assertEq(r.code, 1, 'exit code');
  assert(/path not found/.test(r.stderr), `stderr: ${r.stderr}`);
});

scenario('non-HTML file → exit 1', ({ tmp }) => {
  const txt = path.join(tmp, 'notes.txt');
  fs.writeFileSync(txt, 'hi');
  const r = runH2v(['export', txt, '--dry-run']);
  assertEq(r.code, 1, 'exit code');
  assert(/not an HTML file/.test(r.stderr), `stderr: ${r.stderr}`);
});

summary();
