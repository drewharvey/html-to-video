//
// Shared test harness used by all tests/test-*.js files. Provides a tiny
// scenario / assert / runH2v API plus ffprobe wrapping for e2e tests.
//
// Each test file is its own subprocess (one per `node tests/test-*.js`
// invocation), so the module-level state below (`failures`, `scenarios`)
// is per-file. Tests just require this module, call `scenario(...)` for
// each case, and `summary()` at the end — `summary` exits the process
// with code 0 if all scenarios passed, 1 otherwise.
//
//   const { scenario, assert, assertEq, runH2v, ffprobe, summary } =
//     require('./_test-harness');
//
//   console.log('test-foo.js — what it tests');
//   scenario('something', ({ tmp }) => { ... });
//   summary();
//
// Pass `--verbose` on the command line to print stack traces on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'cli.js');
const VERBOSE = process.argv.includes('--verbose');

let failures = 0;
let scenarios = 0;

// scenario runs `fn` inside a fresh tmpdir that's cleaned up regardless of
// outcome. fn receives `{ tmp }` where `tmp` is the directory path. On
// throw, the scenario is marked failed but other scenarios continue.
function scenario(name, fn) {
  scenarios++;
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h2v-test-'));
    try {
      fn({ tmp });
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch (err) {
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message.replace(/\n/g, '\n      ')}`);
    if (VERBOSE && err.stack) console.log(err.stack);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

// Floating-point comparison with tolerance — used for duration / frame-rate
// checks where exact equality isn't realistic (e.g. ffmpeg rounding).
function assertNear(actual, expected, tolerance, label) {
  if (typeof actual !== 'number' || isNaN(actual)) {
    throw new Error(`${label}: expected number near ${expected}, got ${actual}`);
  }
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected} ±${tolerance}, got ${actual}`);
  }
}

// Spawn h2v with cwd defaulting to the repo root. Returns
// `{ code, stdout, stderr }`. Pass `opts.cwd` to run in a scratch dir
// (commonly the scenario's tmpdir, so `output/` doesn't collide with
// the real repo output).
function runH2v(args, opts = {}) {
  const r = spawnSync('node', [CLI, ...args], {
    cwd: opts.cwd || REPO_ROOT,
    encoding: 'utf-8',
    // E2E exports can be slow; give them up to 3 minutes before timing out
    // (the recorder loop alone can take ~1 min on a heavy fixture). Most
    // calls return in under 5 s.
    timeout: opts.timeout || 180_000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ffprobe JSON wrapper used by e2e tests. Returns parsed
// `{ format: {...}, streams: [{...}] }`. The first video stream is at
// streams[0] for typical h2v outputs.
function ffprobe(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-of', 'json',
    file,
  ], { encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`ffprobe failed on ${file}: ${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

// Extract a single frame from a video at the given video-time and return
// the raw RGBA pixel buffer (Buffer of length width*height*4). Used by
// the sync test to sample bar widths and by the alpha test to verify
// pre-multiplication.
function extractFrameRgba(videoPath, atSeconds) {
  // Accurate seek (-ss after -i). Pipe stdout for the raw video.
  const r = spawnSync('ffmpeg', [
    '-v', 'error',
    '-i', videoPath,
    '-ss', String(atSeconds),
    '-frames:v', '1',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-',
  ], { encoding: 'buffer', maxBuffer: 200 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`ffmpeg frame extract failed: ${r.stderr ? r.stderr.toString() : ''}`);
  }
  return r.stdout;
}

function fileSize(p) {
  return fs.statSync(p).size;
}

function summary() {
  console.log('');
  if (failures === 0) {
    console.log(`\x1b[32m${scenarios}/${scenarios} scenarios passed.\x1b[0m`);
    process.exit(0);
  } else {
    console.log(`\x1b[31m${failures}/${scenarios} scenarios failed.\x1b[0m`);
    process.exit(1);
  }
}

module.exports = {
  REPO_ROOT,
  CLI,
  scenario,
  assert,
  assertEq,
  assertNear,
  runH2v,
  ffprobe,
  extractFrameRgba,
  fileSize,
  summary,
};
