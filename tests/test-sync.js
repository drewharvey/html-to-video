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

// One scenario, deliberately. Failures show which of the six bars is
// out of sync; that's more useful than splitting into six independent
// scenarios because the underlying export is the same artifact.
console.log('test-sync.js — animation timing sync (all 6 time sources)');
console.log('');

scenario('sync-test.html: all 6 time sources in lockstep at slowdown 6', ({ tmp }) => {
  const outVideo = path.join(tmp, 'sync.mp4');
  // Default slowdown (6) — the production setting. The shim wraps every
  // JS time source; setPlaybackRate slows CSS. Both must align.
  const r = runH2v([
    'export', 'tests/sync-test.html',
    '--width', String(VW),
    '--height', String(VH),
    '--scale', '1',
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

  // ---- Step 3: per-bar assertions.
  //   At t=0.5s: sample at 25%, 50%, 75% of the track horizontally.
  //     - 25%: must be bar color (fill > 25%)
  //     - 50%: bar color is the canonical "midpoint should be ~50%" check —
  //       allow ±10% slop because of ease-in-out etc.
  //     - 75%: must NOT be bar color (fill < 75%)
  //   At t=1.0s: sample at 95% — must be bar color (fully filled).
  const failures = [];
  for (let i = 0; i < BARS.length; i++) {
    const bar = BARS[i];
    const y = barYs[i];
    const { leftX, rightX, width } = trackExtent(endFrame, y, bar.color);
    if (width < 50) {
      failures.push(`bar ${i+1} (${bar.name}): couldn't determine track extent at t=1.0 (width=${width})`);
      continue;
    }

    // t=1.0s: fully filled. Sample at 95% — must be bar color.
    const x95end = leftX + Math.floor(width * 0.95);
    if (!isBarColor(pixelAt(endFrame, x95end, y), bar.color)) {
      failures.push(`bar ${i+1} (${bar.name}): at t=1.0 the 95%-position pixel isn't bar color (bar isn't fully filled)`);
    }

    // t=0.5s: should be at ~50%. Sample at 25%, 50%, 75%.
    const x25 = leftX + Math.floor(width * 0.25);
    const x50 = leftX + Math.floor(width * 0.50);
    const x75 = leftX + Math.floor(width * 0.75);
    const at25 = isBarColor(pixelAt(midFrame, x25, y), bar.color);
    const at50 = isBarColor(pixelAt(midFrame, x50, y), bar.color);
    const at75 = isBarColor(pixelAt(midFrame, x75, y), bar.color);

    if (!at25) {
      failures.push(`bar ${i+1} (${bar.name}): at t=0.5 the 25%-position pixel isn't bar color (filled < 25% — way too slow)`);
    }
    if (at75) {
      failures.push(`bar ${i+1} (${bar.name}): at t=0.5 the 75%-position pixel IS bar color (filled > 75% — way too fast)`);
    }
    // The midpoint (50%) check is the canonical sync invariant. The fill
    // boundary is a sharp edge; the pixel right at 50% could fall on
    // either side of it. We require EITHER the 50% pixel is bar color OR
    // it's adjacent to one (within a few px) — i.e. the boundary is near
    // 50%, not on a wildly off position.
    if (!at50) {
      // Allow some tolerance: check that boundary is within ±10% of 50%
      const x40 = leftX + Math.floor(width * 0.40);
      const x60 = leftX + Math.floor(width * 0.60);
      const at40 = isBarColor(pixelAt(midFrame, x40, y), bar.color);
      const at60 = isBarColor(pixelAt(midFrame, x60, y), bar.color);
      if (!(at40 && !at60)) {
        failures.push(`bar ${i+1} (${bar.name}): boundary at t=0.5 not within 40-60% range (at40=${at40} at50=${at50} at60=${at60})`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`sync mismatch:\n  ${failures.join('\n  ')}`);
  }
});

summary();
