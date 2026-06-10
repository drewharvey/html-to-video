#!/usr/bin/env node
//
// End-to-end test for the seek driver (auto-detected scrub path).
//
// Exports tests/seek-test.html — a page that exposes window.seek and
// honors window.__SCRUB__ (no autoplay) — and verifies that:
//   1. h2v auto-detects the seek driver (stdout reports "driver: seek").
//   2. The captured frames are correct: a pure-function-of-time animation
//      reads ~50% at the clip midpoint and ~100% at the end. Because the
//      fixture does NOT autoplay under __SCRUB__, a mis-detection (falling
//      back to the play driver) would capture a frozen frame-0 — the
//      midpoint check would fail loudly.
//
// What a regression here would catch:
//   - Detection probe broken (typeof window.seek check)
//   - __SCRUB__ not injected before page scripts (page autoplays, fights seek)
//   - seek loop driving the wrong timestamps / off-by-one frame indexing
//
//   node tests/test-seek.js
//   npm run test:seek

const path = require('path');
const {
  REPO_ROOT,
  scenario,
  assert,
  runH2v,
  extractFrameRgba,
  summary,
} = require('./_test-harness');

const VW = 640;
const VH = 360;

console.log('test-seek.js — seek driver auto-detection + frame correctness');
console.log('');

scenario('seek-test.html: auto-detects seek driver and scrubs frame-perfect', ({ tmp }) => {
  const outVideo = path.join(tmp, 'seek.mp4');
  const r = runH2v([
    'export', 'tests/seek-test.html',
    '--width', String(VW),
    '--height', String(VH),
    '--scale', '1',
    '--out', outVideo,
  ], { cwd: REPO_ROOT });
  assert(r.code === 0, `export exit ${r.code}; stderr: ${r.stderr}`);

  // 1. Driver was auto-detected as seek.
  assert(
    /driver:\s*seek/.test(r.stdout),
    `expected "driver: seek" in output; got:\n${r.stdout}`
  );

  // The fixture is 2s. Both bars fill 0→100%; the linear bar reads exactly
  // 50% at the midpoint. Sample at t=1.0s (~50%) and t=1.95s (~100%).
  const midFrame = extractFrameRgba(outVideo, 1.0);
  const endFrame = extractFrameRgba(outVideo, 1.95);

  function pixelAt(buf, x, y) {
    const i = (y * VW + x) * 4;
    return [buf[i], buf[i + 1], buf[i + 2]];
  }
  function isBarColor(px, target, tol = 60) {
    return Math.abs(px[0] - target[0]) < tol
        && Math.abs(px[1] - target[1]) < tol
        && Math.abs(px[2] - target[2]) < tol;
  }

  // The linear bar (#4ade80) is the canonical check — exact at every t.
  const LINEAR = [0x4a, 0xde, 0x80];

  // Locate the linear bar's center y by scanning the center column of the
  // end frame (fully filled → its color spans the row).
  const centerX = Math.floor(VW / 2);
  let barY = -1;
  for (let y = 0; y < VH; y++) {
    if (isBarColor(pixelAt(endFrame, centerX, y), LINEAR)) {
      let count = 0;
      for (let dy = 0; dy < 6; dy++) {
        if (isBarColor(pixelAt(endFrame, centerX, y + dy), LINEAR)) count++;
      }
      if (count >= 4) { barY = y + 2; break; }
    }
  }
  assert(barY >= 0, 'couldn\'t locate the linear bar in the end frame');

  // Track horizontal extent at the end frame (fully filled).
  let leftX = -1, rightX = -1;
  for (let x = 0; x < VW; x++) {
    if (isBarColor(pixelAt(endFrame, x, barY), LINEAR)) { leftX = x; break; }
  }
  for (let x = VW - 1; x >= 0; x--) {
    if (isBarColor(pixelAt(endFrame, x, barY), LINEAR)) { rightX = x; break; }
  }
  const width = rightX - leftX;
  assert(width >= 50, `couldn't determine track extent at end (width=${width})`);

  // End: 95% position must be bar color (fully filled — proves the page
  // was actually driven, not frozen at frame 0).
  const x95 = leftX + Math.floor(width * 0.95);
  assert(
    isBarColor(pixelAt(endFrame, x95, barY), LINEAR),
    'at t=1.95 the 95%-position pixel isn\'t bar color (bar never filled — '
    + 'page may have been frozen at frame 0, i.e. seek not driven)'
  );

  // Midpoint: 25% filled, 50% filled, 75% NOT filled — boundary at ~50%.
  const x25 = leftX + Math.floor(width * 0.25);
  const x50 = leftX + Math.floor(width * 0.50);
  const x75 = leftX + Math.floor(width * 0.75);
  assert(
    isBarColor(pixelAt(midFrame, x25, barY), LINEAR),
    'at t=1.0 the 25%-position pixel isn\'t bar color (filled < 25%)'
  );
  assert(
    isBarColor(pixelAt(midFrame, x50, barY), LINEAR),
    'at t=1.0 the 50%-position pixel isn\'t bar color (linear bar should be exactly 50%)'
  );
  assert(
    !isBarColor(pixelAt(midFrame, x75, barY), LINEAR),
    'at t=1.0 the 75%-position pixel IS bar color (filled > 75% — too fast)'
  );
});

// Frame-sharding: --concurrency on a single seek animation splits its frames
// across browsers (seek is order-independent, so disjoint ranges run in
// parallel and reassemble). The output must be byte-identical to a
// single-worker recording — sharding is a speedup, never a content change.
function framesIdentical(videoA, videoB, times) {
  for (const t of times) {
    const a = extractFrameRgba(videoA, t);
    const b = extractFrameRgba(videoB, t);
    if (a.length !== b.length || !a.equals(b)) return t;
  }
  return null;
}

scenario('seek-test.html: --concurrency 2 shards and matches single-worker', ({ tmp }) => {
  const base = ['export', 'tests/seek-test.html', '--width', String(VW), '--height', String(VH), '--scale', '1'];
  const v1 = path.join(tmp, 'one.mp4');
  const v2 = path.join(tmp, 'two.mp4');
  const r1 = runH2v([...base, '--out', v1], { cwd: REPO_ROOT });
  assert(r1.code === 0, `1-worker export exit ${r1.code}; stderr: ${r1.stderr}`);
  const r2 = runH2v([...base, '--concurrency', '2', '--out', v2], { cwd: REPO_ROOT });
  assert(r2.code === 0, `2-worker export exit ${r2.code}; stderr: ${r2.stderr}`);

  // It actually sharded (120 frames / 60 min-per-shard = 2 shards).
  assert(
    /across\s+2\s+browsers/.test(r2.stdout),
    `expected frame-sharding across 2 browsers; got:\n${r2.stdout}`
  );

  // Byte-identical frames at start, mid, end.
  const diff = framesIdentical(v1, v2, [0.1, 1.0, 1.9]);
  assert(diff === null, `sharded output differs from single-worker at t=${diff}s`);
});

// Regression guard for the warm-up replay in captureSeekRange. This fixture's
// seek() is deliberately ORDER-DEPENDENT (carries a step counter), like real
// timeline engines. If a shard cold-jumps to its start frame instead of
// replaying the seek prefix, its frames render differently than single-worker
// and this scenario fails. It's the canary for the warm-up logic.
scenario('seek-stateful-test.html: sharded matches single-worker (warm-up replay)', ({ tmp }) => {
  const base = ['export', 'tests/seek-stateful-test.html', '--width', String(VW), '--height', String(VH), '--scale', '1'];
  const v1 = path.join(tmp, 'sf-one.mp4');
  const v2 = path.join(tmp, 'sf-two.mp4');
  const r1 = runH2v([...base, '--out', v1], { cwd: REPO_ROOT });
  assert(r1.code === 0, `1-worker export exit ${r1.code}; stderr: ${r1.stderr}`);
  const r2 = runH2v([...base, '--concurrency', '2', '--out', v2], { cwd: REPO_ROOT });
  assert(r2.code === 0, `2-worker export exit ${r2.code}; stderr: ${r2.stderr}`);
  assert(/across\s+2\s+browsers/.test(r2.stdout), `expected sharding; got:\n${r2.stdout}`);

  // The order-dependent bar position must match across the shard boundary
  // (frame 60). Without warm-up, the second shard's frames would be wrong.
  const diff = framesIdentical(v1, v2, [0.1, 1.0, 1.1, 1.5, 1.9]);
  assert(diff === null, `stateful sharded output differs from single-worker at t=${diff}s (warm-up replay broken?)`);
});

summary();
