#!/usr/bin/env node
//
// Unit tests for the pure, logic-dense functions in cli.js. These require()
// cli.js directly (via the require.main !== module export seam) and call the
// functions in-process — no subprocess, no Chromium, no ffmpeg. Millisecond
// coverage for the math the recorder/encoder build on.
//
//   node tests/test-unit.js
//   npm run test:unit

const { scenario, assert, assertEq, summary } = require('./_test-harness');
const h2v = require('../cli.js');

console.log('test-unit.js — pure-function unit tests');
console.log('');

// ===========================================================================
// splitFrameRanges — partitions [0, total) into `parts` contiguous ranges
// with no gaps/overlap; degrades gracefully when parts > total.
// ===========================================================================
scenario('splitFrameRanges: contiguous, complete, no overlap', () => {
  const cases = [
    [100, 4],
    [101, 4],   // remainder distributed to leading shards
    [7, 3],
    [60, 1],
    [3, 5],     // parts > total → one range per frame, no empties
  ];
  for (const [total, parts] of cases) {
    const ranges = h2v.splitFrameRanges(total, parts);
    // Cover exactly [0, total): first starts at 0, each starts where the
    // previous ended, last ends at total.
    assertEq(ranges[0][0], 0, `${total}/${parts}: starts at 0`);
    assertEq(ranges[ranges.length - 1][1], total, `${total}/${parts}: ends at total`);
    let covered = 0;
    for (let i = 0; i < ranges.length; i++) {
      const [s, e] = ranges[i];
      assert(e > s, `${total}/${parts}: range ${i} is non-empty`);
      if (i > 0) assertEq(s, ranges[i - 1][1], `${total}/${parts}: range ${i} is contiguous`);
      covered += e - s;
    }
    assertEq(covered, total, `${total}/${parts}: total frames covered`);
    assert(ranges.length <= parts, `${total}/${parts}: never more than ${parts} ranges`);
  }
});

// ===========================================================================
// computeRenderPlan — the 3-mode integer-render / downscale resolution math.
// ===========================================================================
scenario('computeRenderPlan: default 4K-box fit (exact integer multiples)', () => {
  // 1280×720 → ×3 = 3840×2160, exact (no downscale: height*scale === outputHeight)
  assertEq(h2v.computeRenderPlan(1280, 720, {}), { renderScale: 3, outputHeight: 2160 }, '1280x720');
  // 1920×1080 → ×2 = 3840×2160, exact
  assertEq(h2v.computeRenderPlan(1920, 1080, {}), { renderScale: 2, outputHeight: 2160 }, '1920x1080');
  // 1080×1920 portrait → orientation-aware: long=1920 → ×2, output height 3840
  assertEq(h2v.computeRenderPlan(1080, 1920, {}), { renderScale: 2, outputHeight: 3840 }, '1080x1920 portrait');
});

scenario('computeRenderPlan: non-integer fit renders up then downscales', () => {
  // 1600×900 → long=1600 fit=2.4 → render ×3 (4800×2700), downscale to 2160
  const p = h2v.computeRenderPlan(1600, 900, {});
  assertEq(p.renderScale, 3, '1600x900 renderScale');
  assertEq(p.outputHeight, 2160, '1600x900 outputHeight');
  // Downscale is required here (height*scale = 2700 !== 2160).
  assert(900 * p.renderScale !== p.outputHeight, '1600x900 needs a downscale step');
});

scenario('computeRenderPlan: --scale is density mode (no downscale)', () => {
  assertEq(
    h2v.computeRenderPlan(640, 360, { scaleExplicit: true, scale: 2 }),
    { renderScale: 2, outputHeight: null },
    '--scale 2',
  );
});

scenario('computeRenderPlan: --output-height renders up to nearest integer then downscales', () => {
  // 1080 → 1440: ceil(1440/1080) = 2 render scale, downscale to 1440
  assertEq(
    h2v.computeRenderPlan(2560, 1080, { outputHeight: 1440 }),
    { renderScale: 2, outputHeight: 1440 },
    '--output-height 1440 from 1080',
  );
});

// ===========================================================================
// needsDownscale / downscaleFilter — the single source of truth for the
// Lanczos-downscale step shared by the GIF path, video path, and run summary.
// ===========================================================================
scenario('needsDownscale: only in target mode with a non-exact fit', () => {
  // Density mode (--scale): outputHeight null → never downscale.
  assert(!h2v.needsDownscale({ height: 360, renderScale: 2, outputHeight: null }), 'density mode');
  // Exact integer fit (720×3 === 2160) → no resample.
  assert(!h2v.needsDownscale({ height: 720, renderScale: 3, outputHeight: 2160 }), 'exact fit');
  // Overshoot (900×3 = 2700 → 2160) → downscale.
  assert(h2v.needsDownscale({ height: 900, renderScale: 3, outputHeight: 2160 }), 'overshoot');
  // No job (e.g. summary with nothing) → false.
  assert(!h2v.needsDownscale(null), 'null job');
  assert(!h2v.needsDownscale(undefined), 'undefined job');
});

scenario('downscaleFilter: Lanczos scale to target height, width auto-even', () => {
  assertEq(h2v.downscaleFilter({ outputHeight: 2160 }), 'scale=-2:2160:flags=lanczos', 'filter string');
});

// ===========================================================================
// deriveThemes — theme selection precedence and validation.
// ===========================================================================
scenario('deriveThemes: no flag → default only', () => {
  assertEq(h2v.deriveThemes([], null, 'x'), [null], 'unthemed page');
  assertEq(h2v.deriveThemes(['dark', 'light'], null, 'x'), [null], 'themed page, no flag → default');
});

scenario('deriveThemes: --theme all → every declared (default normalized to null)', () => {
  assertEq(h2v.deriveThemes(['dark', 'light'], 'all', 'x'), [null, 'light'], 'all themes');
  assertEq(h2v.deriveThemes([], 'all', 'x'), [null], 'all on unthemed → single default');
});

scenario('deriveThemes: explicit list maps default → null, keeps others', () => {
  assertEq(h2v.deriveThemes(['dark', 'light'], ['light'], 'x'), ['light'], 'non-default');
  assertEq(h2v.deriveThemes(['dark', 'light'], ['dark'], 'x'), [null], 'default normalized');
});

scenario('deriveThemes: undeclared theme throws', () => {
  let threw = false;
  try { h2v.deriveThemes(['dark', 'light'], ['nope'], 'clip'); } catch { threw = true; }
  assert(threw, 'undeclared theme rejected');
  threw = false;
  try { h2v.deriveThemes([], ['x'], 'clip'); } catch { threw = true; }
  assert(threw, 'theme requested on page with no h2v-themes rejected');
});

// ===========================================================================
// safeJsonForScript — escapes </ so embedded HTML can't break the outer
// <script>. (The review page's load-bearing escape.)
// ===========================================================================
scenario('safeJsonForScript: escapes </script> inside embedded values', () => {
  const out = h2v.safeJsonForScript({ html: '<div></div><script>x</script>' });
  assert(!/<\/script>/.test(out), 'no raw </script> survives');
  assert(out.includes('<\\/script>'), 'closing tag is escaped to <\\/script>');
  // Round-trips back to the original value (the escape is JS/JSON-invisible).
  assertEq(JSON.parse(out).html, '<div></div><script>x</script>', 'value round-trips');
});

summary();
