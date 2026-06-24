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
// parallel and reassemble). Sharding must not change the CONTENT — frame N
// shows the same scene whether captured in one pass or by a shard.
//
// We compare with a small tolerance rather than byte-for-byte. Byte-identity
// would be testing Chromium's cross-process rasterization determinism, not
// h2v: two separate browser processes don't guarantee bit-identical text
// anti-aliasing / font hinting (it differs by platform — matched on macOS,
// drifted by a sub-pixel on Linux CI). The real invariant is "same content",
// so we flag a frame only when a meaningful FRACTION of pixels differ. A real
// sharding bug (e.g. a missing warm-up replay mis-positions a whole bar)
// moves ~5% of pixels — far above sub-pixel AA jitter (well under 1%).
const PIXEL_DIFF_THRESHOLD = 12;   // per-channel 0-255; ignore AA micro-diffs
const MAX_DIFF_FRACTION = 0.02;    // >2% of pixels differing = real change

function frameDiffFraction(a, b) {
  if (a.length !== b.length) return 1;
  let differing = 0;
  const pixels = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > PIXEL_DIFF_THRESHOLD ||
        Math.abs(a[i + 1] - b[i + 1]) > PIXEL_DIFF_THRESHOLD ||
        Math.abs(a[i + 2] - b[i + 2]) > PIXEL_DIFF_THRESHOLD) {
      differing++;
    }
  }
  return differing / pixels;
}

// Returns { t, fraction } for the first frame that differs beyond tolerance,
// or null if every sampled frame matches.
function framesMatch(videoA, videoB, times) {
  for (const t of times) {
    const f = frameDiffFraction(extractFrameRgba(videoA, t), extractFrameRgba(videoB, t));
    if (f > MAX_DIFF_FRACTION) return { t, fraction: f };
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

  // Same content at start, mid, end (tolerant — see framesMatch).
  const diff = framesMatch(v1, v2, [0.1, 1.0, 1.9]);
  assert(diff === null,
    diff && `sharded output differs from single-worker at t=${diff.t}s ` +
    `(${(diff.fraction * 100).toFixed(1)}% of pixels)`);
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
  const diff = framesMatch(v1, v2, [0.1, 1.0, 1.1, 1.5, 1.9]);
  assert(diff === null,
    diff && `stateful sharded output differs from single-worker at t=${diff.t}s ` +
    `(${(diff.fraction * 100).toFixed(1)}% of pixels) — warm-up replay broken?`);
});

// "Does NOT shard" invariants — the inverse of the sharding tests above.
// Frame-sharding is gated to seek jobs that are big enough; assert the two
// documented cases that must stay single-browser, via the driver log (no
// "across N browsers" fan-out line). Short --duration keeps these cheap.

// A play (non-seek) animation can't be sharded (real-time, sequential). With
// --concurrency >1 on a single job it must collapse to one browser.
scenario('play animation + --concurrency 2 → single browser (no shard)', ({ tmp }) => {
  const r = runH2v([
    'export', 'tests/sync-test.html',
    '--width', String(VW), '--height', String(VH), '--scale', '1',
    '--duration', '0.5',
    '--concurrency', '2',
    '--out', path.join(tmp, 'play.mp4'),
  ], { cwd: REPO_ROOT });
  assert(r.code === 0, `export exit ${r.code}; stderr: ${r.stderr}`);
  assert(/driver:\s*slowdown/.test(r.stdout), `expected play (slowdown) driver; got:\n${r.stdout}`);
  assert(!/across\s+\d+\s+browsers/.test(r.stdout), `play job must not shard; got:\n${r.stdout}`);
});

// A seek job below SEEK_SHARD_MIN_FRAMES (60) isn't worth splitting → K=1.
// 0.5s × 60fps = 30 frames < 60, so even --concurrency 4 stays single-browser.
scenario('seek animation below shard threshold + --concurrency 4 → no shard', ({ tmp }) => {
  const r = runH2v([
    'export', 'tests/seek-test.html',
    '--width', String(VW), '--height', String(VH), '--scale', '1',
    '--duration', '0.5',
    '--concurrency', '4',
    '--out', path.join(tmp, 'small-seek.mp4'),
  ], { cwd: REPO_ROOT });
  assert(r.code === 0, `export exit ${r.code}; stderr: ${r.stderr}`);
  assert(/driver:\s*seek/.test(r.stdout), `expected seek driver; got:\n${r.stdout}`);
  assert(!/across\s+\d+\s+browsers/.test(r.stdout), `sub-threshold seek must not shard; got:\n${r.stdout}`);
});

summary();
