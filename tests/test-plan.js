#!/usr/bin/env node
//
// Correctness tests for `h2v export --dry-run` — the pre-browser pipeline
// (argument parsing, metadata extraction, quality-preset application,
// alpha coupling, codec/container matrix, plan construction, validation,
// error paths). No Puppeteer / Chromium dependency.
//
// What this file covers (and what it doesn't):
//   ✓ everything before `if (opts.dryRun) return` in main()
//   ✗ recorder, screenshot pipeline, ffmpeg encoding, output files
//
// E2E coverage of the actual recorder/encoder lives in test-export-flags.js
// (and the sync / alpha e2e files), which run in a separate slower workflow.
//
//   node tests/test-plan.js
//   npm run test:plan

const fs = require('fs');
const path = require('path');
const {
  scenario,
  assert,
  assertEq,
  runH2v,
  summary,
} = require('./_test-harness');

// Helper: count occurrences of a substring in a string.
function count(haystack, needle) {
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

console.log('test-plan.js — h2v export --dry-run plan correctness');
console.log('');

// ===========================================================================
// Metadata extraction
// ===========================================================================

scenario('single file meta → plan reflects duration + viewport + themes', ({ tmp }) => {
  const file = path.join(tmp, 'meta.html');
  fs.writeFileSync(file, `<!DOCTYPE html>
<html><head>
<meta name="h2v-duration" content="7s">
<meta name="h2v-viewport" content="1080x1080">
<meta name="h2v-themes" content="dark,light,vibrant">
</head><body></body></html>`);
  const r = runH2v(['export', file, '--dry-run'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  // Plan line format: "[meta]  7s × 60fps =   420 frames → output/meta.mp4 (from meta tag)"
  assert(/7s × 60fps/.test(r.stdout), `expected "7s × 60fps" in stdout: ${r.stdout}`);
  // The plan emits only the default theme (no --theme flag); the others
  // aren't recorded but they're declared so it shouldn't error.
});

scenario('bundle decomposition → plan has one row per inner animation', () => {
  const r = runH2v(['export', 'demo/bundle.html', '--dry-run']);
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  // demo/bundle.html has 12 ANIMATION blocks. Plan summary mentions 12.
  assert(/Plan: 12 animations,/.test(r.stdout),
    `expected "12 animations" in plan summary: ${r.stdout.split('\n').slice(0,3).join(' | ')}`);
});

scenario('directory mode → all .html files included, skip rules honoured', ({ tmp }) => {
  // Three real files + one dotfile + a review.html — only the three should
  // appear in the plan.
  fs.writeFileSync(path.join(tmp, 'a.html'), '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  fs.writeFileSync(path.join(tmp, 'b.html'), '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  fs.writeFileSync(path.join(tmp, 'c.html'), '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  fs.writeFileSync(path.join(tmp, '.hidden.html'), '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  fs.writeFileSync(path.join(tmp, 'review.html'), '<html><head><meta name="h2v-duration" content="1s"></head></html>');

  const r = runH2v(['export', '.', '--dry-run'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  assert(/Plan: 3 animations,/.test(r.stdout),
    `expected exactly 3 animations (dotfile + review.html skipped); got: ${r.stdout}`);
});

scenario('missing duration meta → fallback to default', ({ tmp }) => {
  const file = path.join(tmp, 'no-duration.html');
  fs.writeFileSync(file, '<!DOCTYPE html><html></html>');
  const r = runH2v(['export', file, '--dry-run'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  // The plan should still complete; default duration is used silently
  // (this is by design — bundle-side meta-missing emits a note, but
  // export uses DEFAULTS.duration when there's no source for one).
  assert(/Plan: 1 animation,/.test(r.stdout), `expected plan to render: ${r.stdout}`);
});

scenario('per-file viewport meta overrides global default for that animation', ({ tmp }) => {
  const f1 = path.join(tmp, 'square.html');
  fs.writeFileSync(f1, '<html><head><meta name="h2v-duration" content="1s"><meta name="h2v-viewport" content="1080x1080"></head></html>');
  const f2 = path.join(tmp, 'wide.html');
  fs.writeFileSync(f2, '<html><head><meta name="h2v-duration" content="1s"></head></html>');

  const r = runH2v(['export', f1, f2, '--dry-run'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  // When per-job viewports differ, printPlan annotates each row with the
  // applied dimensions in brackets. f1 (meta) → 1080×1080; f2 (no meta) →
  // 1280×720 default.
  assert(/\[1080×1080\]/.test(r.stdout),
    `expected "[1080×1080]" in plan (meta viewport applied): ${r.stdout}`);
  assert(/\[1280×720\]/.test(r.stdout),
    `expected "[1280×720]" in plan (default viewport for the other): ${r.stdout}`);
});

// ===========================================================================
// Flag overrides
// ===========================================================================

scenario('--duration N overrides per-file meta', ({ tmp }) => {
  const file = path.join(tmp, 'meta.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="7s"></head></html>');
  const r = runH2v(['export', file, '--duration', '3', '--dry-run'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  // Plan should show 3s, not the meta's 7s. Look for the override marker.
  assert(/3s × 60fps/.test(r.stdout),
    `expected "3s × 60fps" (override) in stdout: ${r.stdout}`);
  assert(/--duration override/.test(r.stdout),
    `expected "--duration override" annotation: ${r.stdout}`);
});

scenario('--width + --height override per-animation viewports (unifies)', ({ tmp }) => {
  // Two files with different viewport metas. Without --width/--height,
  // we'd see distinct [WxH] annotations per row (covered by the preceding
  // test). WITH --width/--height passed, the override unifies them: both
  // jobs end up with the same viewport, so no per-row annotation appears.
  const f1 = path.join(tmp, 'square.html');
  fs.writeFileSync(f1, '<html><head><meta name="h2v-duration" content="1s"><meta name="h2v-viewport" content="1080x1080"></head></html>');
  const f2 = path.join(tmp, 'wide.html');
  fs.writeFileSync(f2, '<html><head><meta name="h2v-duration" content="1s"><meta name="h2v-viewport" content="800x600"></head></html>');

  const r = runH2v(['export', f1, f2, '--width', '640', '--height', '360', '--dry-run'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  // Override unified the viewports → no per-row [WxH] annotation.
  assert(!/\[1080×1080\]/.test(r.stdout) && !/\[800×600\]/.test(r.stdout),
    `expected no per-row viewport annotation (override unifies), got: ${r.stdout}`);
});

scenario('--width alone forces both dims to override per-animation viewports (coupled)', ({ tmp }) => {
  // Same shape as the previous test but only --width is passed. Per
  // CLAUDE.md ("passing either makes both override"), --width alone should
  // still unify the viewports (height takes default 720, NOT inheriting
  // the per-file metas).
  const f1 = path.join(tmp, 'square.html');
  fs.writeFileSync(f1, '<html><head><meta name="h2v-duration" content="1s"><meta name="h2v-viewport" content="1080x1080"></head></html>');
  const f2 = path.join(tmp, 'wide.html');
  fs.writeFileSync(f2, '<html><head><meta name="h2v-duration" content="1s"><meta name="h2v-viewport" content="800x600"></head></html>');

  const r = runH2v(['export', f1, f2, '--width', '640', '--dry-run'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  // If the coupling were broken (height inherits per-file meta), we'd see
  // [640×1080] and [640×600]. If it works, both jobs unify to 640×720
  // (default height), no per-row annotation.
  assert(!/\[640×1080\]/.test(r.stdout) && !/\[640×600\]/.test(r.stdout),
    `expected height to default to 720 for both (NOT inherit per-file meta): ${r.stdout}`);
});

scenario('--theme all records every declared theme', ({ tmp }) => {
  const file = path.join(tmp, 'multi.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"><meta name="h2v-themes" content="dark,light,vibrant"></head></html>');
  const r = runH2v(['export', file, '--theme', 'all', '--dry-run'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  // Three jobs in the plan, one per theme.
  assert(/Plan: 3 animations,/.test(r.stdout),
    `expected 3 animations (one per theme) in plan: ${r.stdout}`);
});

scenario('--theme dark,light records the listed subset in order', ({ tmp }) => {
  const file = path.join(tmp, 'multi.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"><meta name="h2v-themes" content="dark,light,vibrant"></head></html>');
  const r = runH2v(['export', file, '--theme', 'dark,light', '--dry-run'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  assert(/Plan: 2 animations,/.test(r.stdout),
    `expected 2 animations (dark + light only): ${r.stdout}`);
});

scenario('--fps honoured in plan', ({ tmp }) => {
  const file = path.join(tmp, 'meta.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="2s"></head></html>');
  const r = runH2v(['export', file, '--fps', '30', '--dry-run'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  assert(/× 30fps/.test(r.stdout),
    `expected "× 30fps" in plan: ${r.stdout}`);
  // --scale is verified end-to-end in test-export-flags.js (the
  // pre-record plan output doesn't surface scaled dimensions, only
  // per-job viewport when varied).
});

// ===========================================================================
// Quality preset matrix
// ===========================================================================

scenario('--quality-preset max → .mov output (prores default)', ({ tmp }) => {
  const file = path.join(tmp, 'meta.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', file, '--quality-preset', 'max', '--dry-run'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  assert(/\.mov/.test(r.stdout), `expected .mov extension (prores default at max): ${r.stdout}`);
});

scenario('--quality-preset high → .mp4 (HEVC 10-bit 4:4:4 + jpeg q=100)', ({ tmp }) => {
  const file = path.join(tmp, 'meta.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', file, '--quality-preset', 'high', '--dry-run'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  assert(/\.mp4/.test(r.stdout), `expected .mp4 extension: ${r.stdout}`);
});

scenario('--quality-preset draft → .mp4', ({ tmp }) => {
  const file = path.join(tmp, 'meta.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', file, '--quality-preset', 'draft', '--dry-run'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  assert(/\.mp4/.test(r.stdout), `expected .mp4 extension: ${r.stdout}`);
});

scenario('default (no --quality-preset) → standard preset → .mp4', ({ tmp }) => {
  const file = path.join(tmp, 'meta.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', file, '--dry-run'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  assert(/\.mp4/.test(r.stdout), `expected .mp4 extension: ${r.stdout}`);
});

// ===========================================================================
// Alpha coupling (guards the CLAUDE.md "couples four options" invariant)
// ===========================================================================

scenario('--alpha (alone) → forces .mov, fps 30', ({ tmp }) => {
  const file = path.join(tmp, 'meta.html');
  // Note: don't put meta name="h2v-duration" at 2s and expect output ext
  // to change — output ext changes based on container, not duration.
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', file, '--alpha', '--dry-run'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  assert(/\.mov/.test(r.stdout), `expected .mov output: ${r.stdout}`);
  assert(/× 30fps/.test(r.stdout), `expected fps stepped down to 30: ${r.stdout}`);
});

scenario('--alpha --codec prores_ks → .mov path', ({ tmp }) => {
  const file = path.join(tmp, 'meta.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', file, '--alpha', '--codec', 'prores_ks', '--dry-run'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  assert(/\.mov/.test(r.stdout), `expected .mov output: ${r.stdout}`);
});

scenario('--alpha --codec png → .mov path', ({ tmp }) => {
  const file = path.join(tmp, 'meta.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', file, '--alpha', '--codec', 'png', '--dry-run'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  assert(/\.mov/.test(r.stdout), `expected .mov output: ${r.stdout}`);
});

scenario('--alpha --fps 60 keeps fps 60 (explicit override beats alphaFps default)', ({ tmp }) => {
  const file = path.join(tmp, 'meta.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', file, '--alpha', '--fps', '60', '--dry-run'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  assert(/× 60fps/.test(r.stdout), `expected fps stays 60 with explicit --fps: ${r.stdout}`);
});

// ===========================================================================
// Error paths — exit 2 + specific message
// ===========================================================================

scenario('--alpha --codec libx264 → exit 2, names allowed codec set', ({ tmp }) => {
  const file = path.join(tmp, 'meta.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', file, '--alpha', '--codec', 'libx264', '--dry-run'], { cwd: tmp });
  assertEq(r.code, 2, 'exit code');
  assert(/qtrle/.test(r.stderr) && /prores_ks/.test(r.stderr) && /png/.test(r.stderr),
    `stderr should name allowed codecs {qtrle, png, prores_ks}: ${r.stderr}`);
});

scenario('--alpha --codec libvpx-vp9 → exit 2 (vp9 not allowed for alpha)', ({ tmp }) => {
  const file = path.join(tmp, 'meta.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', file, '--alpha', '--codec', 'libvpx-vp9', '--dry-run'], { cwd: tmp });
  assertEq(r.code, 2, 'exit code');
});

scenario('--alpha --capture-format jpeg → exit 2', ({ tmp }) => {
  const file = path.join(tmp, 'meta.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', file, '--alpha', '--capture-format', 'jpeg', '--dry-run'], { cwd: tmp });
  assertEq(r.code, 2, 'exit code');
  assert(/png/i.test(r.stderr), `stderr should mention PNG capture requirement: ${r.stderr}`);
});

scenario('--alpha-mode straight without --alpha → exit 2', ({ tmp }) => {
  const file = path.join(tmp, 'meta.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', file, '--alpha-mode', 'straight', '--dry-run'], { cwd: tmp });
  assertEq(r.code, 2, 'exit code');
  assert(/--alpha/.test(r.stderr), `stderr should mention --alpha requirement: ${r.stderr}`);
});

scenario('--codec libvpx-vp9 --container mp4 → exit 2', ({ tmp }) => {
  const file = path.join(tmp, 'meta.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', file, '--codec', 'libvpx-vp9', '--container', 'mp4', '--dry-run'], { cwd: tmp });
  assertEq(r.code, 2, 'exit code');
  assert(/cannot be packaged/.test(r.stderr),
    `stderr should mention codec/container mismatch: ${r.stderr}`);
});

scenario('--codec prores_ks --container webm → exit 2', ({ tmp }) => {
  const file = path.join(tmp, 'meta.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', file, '--codec', 'prores_ks', '--container', 'webm', '--dry-run'], { cwd: tmp });
  assertEq(r.code, 2, 'exit code');
});

scenario('invalid --quality-preset value → exit 2', ({ tmp }) => {
  const file = path.join(tmp, 'meta.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', file, '--quality-preset', 'bogus', '--dry-run'], { cwd: tmp });
  assertEq(r.code, 2, 'exit code');
});

// ===========================================================================
// validatePlan — output/capture-key collision rails and --out misuse.
// ===========================================================================
scenario('--out with >1 produced video → exit 2', ({ tmp }) => {
  fs.writeFileSync(path.join(tmp, 'a.html'), '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  fs.writeFileSync(path.join(tmp, 'b.html'), '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', tmp, '--out', path.join(tmp, 'out.mp4'), '--dry-run'], { cwd: tmp });
  assertEq(r.code, 2, 'exit code');
  assert(/exactly one MP4/.test(r.stderr), `stderr: ${r.stderr}`);
});

scenario('--out extension mismatching container → exit 2', ({ tmp }) => {
  const file = path.join(tmp, 'clip.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  // default container is mp4; .webm out path mismatches.
  const r = runH2v(['export', file, '--out', path.join(tmp, 'clip.webm'), '--dry-run'], { cwd: tmp });
  assertEq(r.code, 2, 'exit code');
});

scenario('duplicate output paths (same basename, different dirs) → exit 1', ({ tmp }) => {
  fs.mkdirSync(path.join(tmp, 'd1'));
  fs.mkdirSync(path.join(tmp, 'd2'));
  fs.writeFileSync(path.join(tmp, 'd1', 'clip.html'), '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  fs.writeFileSync(path.join(tmp, 'd2', 'clip.html'), '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', path.join(tmp, 'd1', 'clip.html'), path.join(tmp, 'd2', 'clip.html'), '--dry-run'], { cwd: tmp });
  assertEq(r.code, 1, 'exit code');
  assert(/same output path/.test(r.stderr), `stderr: ${r.stderr}`);
});

scenario('captureKey collision (bundle frame vs file) → exit 1', ({ tmp }) => {
  // Bundle "deck" with frame id "intro" → captureKey "deck__intro", output
  // output/deck/intro.mp4. File "deck__intro.html" → captureKey "deck__intro",
  // output output/deck__intro.mp4. Output paths differ, capture keys collide.
  fs.writeFileSync(path.join(tmp, 'deck.html'),
    '<!-- ===== ANIMATION_START id="intro" capture_duration="1s" ===== -->\n' +
    '<!DOCTYPE html><html><head></head><body>intro</body></html>\n' +
    '<!-- ===== ANIMATION_END ===== -->\n');
  fs.writeFileSync(path.join(tmp, 'deck__intro.html'),
    '<html><head><meta name="h2v-duration" content="1s"></head><body>x</body></html>');
  const r = runH2v(['export', path.join(tmp, 'deck.html'), path.join(tmp, 'deck__intro.html'), '--dry-run'], { cwd: tmp });
  assertEq(r.code, 1, 'exit code');
  assert(/capture key/.test(r.stderr), `stderr: ${r.stderr}`);
});

// ===========================================================================
// --capture-quality is JPEG-only. The check must fire ONLY when the user
// passed --capture-quality explicitly — the standard preset's default of 95
// must NOT trip it under --capture-format png (the *Explicit gating canary).
// ===========================================================================
scenario('--capture-format png + explicit --capture-quality → exit 2', ({ tmp }) => {
  const file = path.join(tmp, 'clip.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', file, '--capture-format', 'png', '--capture-quality', '50', '--dry-run'], { cwd: tmp });
  assertEq(r.code, 2, 'exit code');
  assert(/only applies to JPEG/.test(r.stderr), `stderr: ${r.stderr}`);
});

scenario('--capture-format png alone → exit 0 (preset default 95 not treated as explicit)', ({ tmp }) => {
  const file = path.join(tmp, 'clip.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const r = runH2v(['export', file, '--capture-format', 'png', '--dry-run'], { cwd: tmp });
  assertEq(r.code, 0, `exit ${r.code}; stderr: ${r.stderr}`);
});

// ===========================================================================
// --paste path derivation. The fixed `paste` basename lands single files at
// output/paste.<ext> and bundles at output/paste/<id>.<ext>. (Dry-run, piped
// HTML via stdin — no browser.)
// ===========================================================================
scenario('--paste single file → output/paste.mp4', () => {
  const r = runH2v(['export', '--paste', '--dry-run'], {
    input: '<!DOCTYPE html><html><head><meta name="h2v-duration" content="1s"></head><body>x</body></html>',
  });
  assertEq(r.code, 0, `exit ${r.code}; stderr: ${r.stderr}`);
  assert(/output\/paste\.mp4/.test(r.stdout), `stdout: ${r.stdout}`);
});

scenario('--paste bundle → output/paste/<id>.mp4', () => {
  const r = runH2v(['export', '--paste', '--dry-run'], {
    input:
      '<!-- ===== ANIMATION_START id="intro" capture_duration="1s" ===== -->\n' +
      '<html><body>x</body></html>\n' +
      '<!-- ===== ANIMATION_END ===== -->\n',
  });
  assertEq(r.code, 0, `exit ${r.code}; stderr: ${r.stderr}`);
  assert(/output\/paste\/intro\.mp4/.test(r.stdout), `stdout: ${r.stdout}`);
});

scenario('--paste with a positional path arg → exit 2', () => {
  const r = runH2v(['export', '--paste', 'some.html'], {
    input: '<html></html>',
  });
  assertEq(r.code, 2, 'exit code');
  assert(/cannot be combined with positional/.test(r.stderr), `stderr: ${r.stderr}`);
});

// ===========================================================================
// --paste temp-dir cleanup. The paste dir is created early in main(), before
// the --dry-run early return and the buildPlan/validatePlan process.exit()
// paths — a finally alone would leak it. A process.on('exit') guard must
// clean it up on every exit. This pins that fix (regression for the leak).
// ===========================================================================
scenario('--paste --dry-run cleans up its temp dir (no leak)', () => {
  const os = require('os');
  const tmpdir = os.tmpdir();
  const pasteDirs = () =>
    new Set(fs.readdirSync(tmpdir).filter((n) => n.startsWith('h2v-paste-')));
  const before = pasteDirs();
  const r = runH2v(['export', '--paste', '--dry-run'], {
    input: '<!DOCTYPE html><html><head><meta name="h2v-duration" content="1s"></head><body>hi</body></html>',
  });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  // No h2v-paste-* dir created by this run should survive.
  const leaked = [...pasteDirs()].filter((n) => !before.has(n));
  assertEq(leaked, [], 'temp dirs leaked by --paste --dry-run');
});

summary();
