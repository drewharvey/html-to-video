#!/usr/bin/env node
//
// End-to-end correctness test for animation timing. This is the test
// CLAUDE.md describes informally as "Both bars should read ~50 % at the
// midpoint", now automated.
//
// Exports tests/sync-test.html at low-res with the default slowdown (6),
// extracts frames at the 50% and 100% video timestamps, then samples bar
// pixels to verify that ALL SIX time sources (CSS transition, CSS
// keyframes, Web Animations API, setInterval+performance.now, setInterval+
// Date.now, requestAnimationFrame+timestamp arg) fill in lockstep.
//
// What a regression here would catch:
//   - Shim wrapping bugs (e.g. the rAF double-slow that shipped silently)
//   - Animation.setPlaybackRate disconnect from JS clock
//   - Capture-loop / wall-pacing drift
//
//   node tests/test-sync.js
//   npm run test:sync

const fs = require('fs');
const path = require('path');
const {
  REPO_ROOT,
  scenario,
  assert,
  assertNear,
  runH2v,
  extractFrameRgba,
  summary,
} = require('./_test-harness');

// Viewport: 640 wide is enough for the bars + labels; 500 tall is enough
// to fit all 6 rows (default 1280×720 fits them comfortably, but the
// fixture's natural height at scale 1 cuts off row 6 at 640×360 — see
// the calibration in the test harness work).
const VW = 640;
const VH = 500;

// Slowdown used for the test export. Deliberately higher than the
// production default (6): this test runs on shared CI runners where the
// main thread gets starved during screenshot serialization, which delays
// setInterval callbacks and lets the JS-driven bars drift behind the
// compositor-driven CSS bars under load. A larger slowdown gives every
// time source more wall-time per captured frame, shrinking that jitter.
// It does NOT weaken the test: the shim bugs this guards against (rAF
// double-slow, setPlaybackRate disconnect) are *ratios* — scale-invariant,
// so they show up identically at any slowdown. See CLAUDE.md ("raise on
// slow machines if desync appears").
const SLOWDOWN = 12;

// One scenario, deliberately. Failures show which of the six bars is
// out of sync; that's more useful than splitting into six independent
// scenarios because the underlying export is the same artifact.
console.log('test-sync.js — animation timing sync (all 6 time sources)');
console.log('');

scenario(`sync-test.html: all 6 time sources in lockstep (slowdown ${SLOWDOWN})`, ({ tmp }) => {
  const outVideo = path.join(tmp, 'sync.mp4');
  // The shim wraps every JS time source; setPlaybackRate slows CSS. Both
  // must align — and stay aligned with each other regardless of slowdown.
  const r = runH2v([
    'export', 'tests/sync-test.html',
    '--width', String(VW),
    '--height', String(VH),
    '--scale', '1',
    '--slowdown', String(SLOWDOWN),
    '--out', outVideo,
  ], { cwd: REPO_ROOT });
  assert(r.code === 0, `export exit ${r.code}; stderr: ${r.stderr}`);

  // The fixture is 1.5s. Bars hit 100% at t=1.0s and hold until t=1.5s.
  // Sample at t=0.5s (expect ~50% fill) and t=1.0s (expect ~100% fill).
  const midFrame = extractFrameRgba(outVideo, 0.5);
  const endFrame = extractFrameRgba(outVideo, 1.0);

  // ---- Step 1: locate each bar's vertical centre by scanning the END
  //   frame at a single x in the middle of the track. At t=1.0s every
  //   bar is at 100%, so each row's center column has bar color.
  function pixelAt(buf, x, y) {
    const i = (y * VW + x) * 4;
    return [buf[i], buf[i+1], buf[i+2]];
  }
  // Bar colours from the fixture (sync-test.html). Order matters: row index
  // matches CLAUDE.md's bar numbering 1..6.
  const BARS = [
    { name: 'CSS transition',                color: [0x4a, 0xde, 0x80] }, // #4ade80 green
    { name: 'CSS @keyframes',                color: [0x34, 0xd3, 0x99] }, // #34d399 emerald
    { name: 'Web Animations API',            color: [0x2d, 0xd4, 0xbf] }, // #2dd4bf teal
    { name: 'setInterval + performance.now', color: [0x60, 0xa5, 0xfa] }, // #60a5fa blue
    { name: 'setInterval + Date.now',        color: [0xa7, 0x8b, 0xfa] }, // #a78bfa purple
    { name: 'rAF + timestamp arg',           color: [0xfb, 0xbf, 0x24] }, // #fbbf24 amber
  ];

  // Distance metric in RGB space — close enough is "is this the bar color"
  function isBarColor(px, target, tol = 60) {
    return Math.abs(px[0] - target[0]) < tol
        && Math.abs(px[1] - target[1]) < tol
        && Math.abs(px[2] - target[2]) < tol;
  }

  // Locate each bar's centre y by scanning a center column at the end
  // frame (when each bar is fully filled = its color spans the row).
  const centerX = Math.floor(VW / 2);
  const barYs = [];
  for (const bar of BARS) {
    let found = -1;
    for (let y = 0; y < VH; y++) {
      if (isBarColor(pixelAt(endFrame, centerX, y), bar.color)) {
        // Walk down a few rows to make sure we're in the bar (not a
        // single-pixel anti-alias hit). Take the row that's clearly bar.
        let count = 0;
        for (let dy = 0; dy < 6; dy++) {
          if (isBarColor(pixelAt(endFrame, centerX, y + dy), bar.color)) count++;
        }
        if (count >= 4) { found = y + 2; break; }
      }
    }
    assert(found >= 0, `couldn't locate bar "${bar.name}" in end frame`);
    barYs.push(found);
  }

  // ---- Step 2: locate track horizontal extent. Same row, find the
  //   leftmost and rightmost x where the pixel is bar-coloured at t=1.0s.
  //   That gives us track_left .. track_right. Mid-fill (50%) should hit
  //   bar color at midX = track_left + (track_right - track_left)/2.
  function trackExtent(buf, y, color) {
    let leftX = -1, rightX = -1;
    for (let x = 0; x < VW; x++) {
      if (isBarColor(pixelAt(buf, x, y), color)) { leftX = x; break; }
    }
    for (let x = VW - 1; x >= 0; x--) {
      if (isBarColor(pixelAt(buf, x, y), color)) { rightX = x; break; }
    }
    return { leftX, rightX, width: rightX - leftX };
  }

  // ---- Step 3: measure each bar's fill fraction and verify LOCKSTEP.
  //
  // The invariant this test guards is that all six time sources advance
  // *together*. We measure each bar's actual fill fraction (0..1) at the
  // mid frame and compare the sources to each other, rather than asserting
  // each one hits an absolute position. That distinction is what makes the
  // test robust: a loaded CI runner can slow the whole capture uniformly
  // (every bar shifts by the same amount) — that's environmental drift, not
  // a sync bug, and a relative check ignores it. The structural shim bugs
  // we *do* want to catch (rAF double-slow → one source at ~1/6 rate;
  // setPlaybackRate disconnect → CSS bars race ahead) throw a source off
  // the cohort by ≥0.4, far beyond any tolerance below.

  // Fill fraction = position of the rightmost bar-coloured pixel in the
  // track, as a fraction of track width. Using the rightmost pixel (not a
  // contiguous run) makes it robust to a percentage label punching a hole
  // in the filled region.
  function fillFraction(buf, y, leftX, width, color) {
    let last = -1;
    for (let dx = 0; dx < width; dx++) {
      if (isBarColor(pixelAt(buf, leftX + dx, y), color)) last = dx;
    }
    return (last + 1) / width;
  }

  const failures = [];
  const midFills = new Array(BARS.length).fill(null);
  for (let i = 0; i < BARS.length; i++) {
    const bar = BARS[i];
    const y = barYs[i];
    const { leftX, width } = trackExtent(endFrame, y, bar.color);
    if (width < 50) {
      failures.push(`bar ${i+1} (${bar.name}): couldn't determine track extent at t=1.0 (width=${width})`);
      continue;
    }
    // t=1.0s: each bar holds at 100% (until t=1.5s), so this has margin.
    const endFill = fillFraction(endFrame, y, leftX, width, bar.color);
    if (endFill < 0.9) {
      failures.push(`bar ${i+1} (${bar.name}): only ${(endFill*100).toFixed(0)}% filled at t=1.0 (expected ~100%)`);
    }
    midFills[i] = fillFraction(midFrame, y, leftX, width, bar.color);
  }

  // Lockstep + sanity checks only run if every bar was measurable.
  if (midFills.every((f) => f !== null)) {
    const sorted = [...midFills].sort((a, b) => a - b);
    const median = (sorted[2] + sorted[3]) / 2; // middle two of six
    const spread = sorted[sorted.length - 1] - sorted[0];
    const fillReport = midFills
      .map((f, i) => `bar ${i+1} ${(f*100).toFixed(0)}%`)
      .join(', ');

    // Primary invariant: all six sources fill within a tight band of each
    // other. 0.30 sits comfortably between load jitter (well under 0.15 at
    // this slowdown) and the ≥0.4 gap a structural shim bug produces.
    const LOCKSTEP_SPREAD = 0.30;
    if (spread > LOCKSTEP_SPREAD) {
      failures.push(`time sources out of lockstep at t=0.5: spread ${(spread*100).toFixed(0)}% > ${(LOCKSTEP_SPREAD*100).toFixed(0)}% (${fillReport})`);
    }

    // Loose absolute sanity: the cohort should sit roughly mid-timeline at
    // the midpoint. Wide window — this only trips on gross global breakage
    // (e.g. the slowdown not being applied at all), not the environmental
    // drift the lockstep check deliberately tolerates.
    if (median < 0.25 || median > 0.75) {
      failures.push(`cohort ~${(median*100).toFixed(0)}% filled at t=0.5 (expected ~50%); capture timeline grossly off (${fillReport})`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`sync mismatch:\n  ${failures.join('\n  ')}`);
  }
});

summary();
