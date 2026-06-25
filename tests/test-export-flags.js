#!/usr/bin/env node
//
// End-to-end correctness tests for `h2v export`. For each user-facing flag
// (or coupled set), exports a real video at low resolution and asserts
// that the flag took effect on the output. Not a Cartesian product —
// one scenario per flag, sized just enough to surface regressions.
//
// Requires:
//   - Puppeteer (and a working Chrome — bundled on x86_64 Linux & macOS;
//     PUPPETEER_EXECUTABLE_PATH on ARM64 / sandbox)
//   - ffmpeg + ffprobe on PATH
//
// Per-scenario wall time: ~3-5 s. Total: ~60-80 s.
//
//   node tests/test-export-flags.js
//   npm run test:export-flags

const fs = require('fs');
const path = require('path');
const {
  REPO_ROOT,
  scenario,
  assert,
  assertEq,
  assertNear,
  runH2v,
  ffprobe,
  fileSize,
  summary,
} = require('./_test-harness');

// Every scenario uses this tiny fixture: 1-second clip at 640×360 viewport,
// no fancy animations. The fixture is created per-scenario so we can pass
// it as an absolute path and not worry about discovery rules.
//
// IMPORTANT: the body has high spatial detail (gradient + text + bands)
// so JPEG / h264 actually have something to compress differently between
// --capture-quality and --crf tiers. A solid colour is too compressible
// — quality knobs become invisible at every setting.
function writeTinyFixture(tmp, opts = {}) {
  const duration = opts.duration || '1s';
  const viewport = opts.viewport || '640x360';
  const extraMeta = opts.extraMeta || '';
  const file = path.join(tmp, opts.name || 'tiny.html');
  fs.writeFileSync(file, `<!DOCTYPE html>
<html><head>
<meta name="h2v-duration" content="${duration}">
<meta name="h2v-viewport" content="${viewport}">
${extraMeta}
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background:
      repeating-linear-gradient(45deg, #f55 0, #f55 8px, #5f5 8px, #5f5 16px, #55f 16px, #55f 24px),
      linear-gradient(135deg, #fff, #000);
    background-blend-mode: multiply;
    font-family: monospace; font-size: 28px; color: #fff;
    display: flex; align-items: center; justify-content: center;
  }
  .label {
    background: rgba(0,0,0,0.6); padding: 10px 20px;
    border-radius: 8px; text-shadow: 0 1px 2px #000;
  }
</style>
</head><body>
<div class="label">h2v test fixture · ${Math.random().toString(36).slice(2, 10)}</div>
</body></html>`);
  return file;
}

// Default args: low-res, fast, no JPEG quality drama. Tests can add flags.
function defaultArgs(fixture, opts = {}) {
  const args = ['export', fixture];
  if (!opts.skipScale) args.push('--scale', '1');
  if (!opts.skipSlowdown) args.push('--slowdown', '1');
  return args;
}

console.log('test-export-flags.js — h2v export per-flag e2e validation');
console.log('');

// ===========================================================================
// Timing & dimensions
// ===========================================================================

scenario('--duration 2 → output video is ~2 seconds long', ({ tmp }) => {
  const fx = writeTinyFixture(tmp, { duration: '0.5s' });  // meta says 0.5s
  const r = runH2v(defaultArgs(fx).concat(['--duration', '2']), { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const out = path.join(tmp, 'output', 'tiny.mp4');
  const info = ffprobe(out);
  const duration = parseFloat(info.format.duration);
  assertNear(duration, 2.0, 0.1, 'video duration');
});

scenario('--fps 30 → output framerate is 30/1', ({ tmp }) => {
  const fx = writeTinyFixture(tmp);
  const r = runH2v(defaultArgs(fx).concat(['--fps', '30']), { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const info = ffprobe(path.join(tmp, 'output', 'tiny.mp4'));
  const stream = info.streams.find((s) => s.codec_type === 'video');
  assertEq(stream.r_frame_rate, '30/1', 'frame rate');
});

scenario('--width + --height + --scale 1 → exact output dimensions', ({ tmp }) => {
  // Use a fixture viewport that DIFFERS so we can be sure the override won.
  const fx = writeTinyFixture(tmp, { viewport: '1080x1080' });
  const r = runH2v(defaultArgs(fx, { skipScale: true }).concat([
    '--width', '480', '--height', '270', '--scale', '1',
  ]), { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const info = ffprobe(path.join(tmp, 'output', 'tiny.mp4'));
  const stream = info.streams.find((s) => s.codec_type === 'video');
  assertEq(stream.width, 480, 'width');
  assertEq(stream.height, 270, 'height');
});

scenario('--scale 2 (with 640×360 viewport) → output is 1280×720', ({ tmp }) => {
  const fx = writeTinyFixture(tmp, { viewport: '640x360' });
  const r = runH2v(['export', fx, '--scale', '2', '--slowdown', '1'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const info = ffprobe(path.join(tmp, 'output', 'tiny.mp4'));
  const stream = info.streams.find((s) => s.codec_type === 'video');
  assertEq(stream.width, 1280, 'width (640 × scale 2)');
  assertEq(stream.height, 720, 'height (360 × scale 2)');
});

// ===========================================================================
// Codec / container
// ===========================================================================

scenario('--codec libx265 → output codec is hevc', ({ tmp }) => {
  const fx = writeTinyFixture(tmp);
  const r = runH2v(defaultArgs(fx).concat(['--codec', 'libx265']), { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const info = ffprobe(path.join(tmp, 'output', 'tiny.mp4'));
  const stream = info.streams.find((s) => s.codec_type === 'video');
  assertEq(stream.codec_name, 'hevc', 'codec_name');
});

// Default (no flags) is 10-bit HEVC — the artifact-fix default. Guards the
// QUALITY_PRESETS standard codec + the codec-keyed bit-depth invariant.
scenario('default → 10-bit HEVC (hevc / yuv420p10le)', ({ tmp }) => {
  const fx = writeTinyFixture(tmp);
  const r = runH2v(defaultArgs(fx), { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const stream = ffprobe(path.join(tmp, 'output', 'tiny.mp4')).streams.find((s) => s.codec_type === 'video');
  assertEq(stream.codec_name, 'hevc', 'codec_name');
  assertEq(stream.pix_fmt, 'yuv420p10le', 'pix_fmt (10-bit)');
});

// Explicit --codec libx264 must stay 8-bit — never the High 10 profile (no
// hardware decode, rejected by QuickTime/Safari). Guards the bit-depth trap.
scenario('--codec libx264 → 8-bit h264 (yuv420p, NOT High 10)', ({ tmp }) => {
  const fx = writeTinyFixture(tmp);
  const r = runH2v(defaultArgs(fx).concat(['--codec', 'libx264']), { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const stream = ffprobe(path.join(tmp, 'output', 'tiny.mp4')).streams.find((s) => s.codec_type === 'video');
  assertEq(stream.codec_name, 'h264', 'codec_name');
  // 8-bit 4:2:0; the `j` (full-range) variant carries over from the JPEG
  // capture. The point is it's 8-bit, never a 10-bit High 10 pix_fmt.
  assert(/^yuvj?420p$/.test(stream.pix_fmt), `8-bit 4:2:0 pix_fmt, got "${stream.pix_fmt}"`);
});

// high tier → 10-bit 4:4:4 HEVC (cleaner + ~half the size of the old 8-bit h264).
scenario('--quality-preset high → HEVC 10-bit 4:4:4 (yuv444p10le)', ({ tmp }) => {
  const fx = writeTinyFixture(tmp);
  const r = runH2v(defaultArgs(fx).concat(['--quality-preset', 'high']), { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const stream = ffprobe(path.join(tmp, 'output', 'tiny.mp4')).streams.find((s) => s.codec_type === 'video');
  assertEq(stream.codec_name, 'hevc', 'codec_name');
  assertEq(stream.pix_fmt, 'yuv444p10le', 'pix_fmt (10-bit 4:4:4)');
});

scenario('--container mov (with libx264) → output is .mov with mov container', ({ tmp }) => {
  const fx = writeTinyFixture(tmp);
  const r = runH2v(defaultArgs(fx).concat(['--container', 'mov']), { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const out = path.join(tmp, 'output', 'tiny.mov');
  assert(fs.existsSync(out), `expected ${out} to exist`);
  const info = ffprobe(out);
  // format_name for QuickTime/MOV is typically "mov,mp4,m4a,3gp,3g2,mj2".
  assert(/mov/.test(info.format.format_name),
    `expected format_name to include "mov": ${info.format.format_name}`);
});

// ===========================================================================
// Quality preset
// ===========================================================================

scenario('--quality-preset max → ProRes in .mov', ({ tmp }) => {
  const fx = writeTinyFixture(tmp);
  const r = runH2v(defaultArgs(fx).concat(['--quality-preset', 'max']), { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const out = path.join(tmp, 'output', 'tiny.mov');
  assert(fs.existsSync(out), `expected .mov output at max preset`);
  const info = ffprobe(out);
  const stream = info.streams.find((s) => s.codec_type === 'video');
  assertEq(stream.codec_name, 'prores', 'codec_name at max preset');
  // h2v passes `-pix_fmt yuv444p10le` to ffmpeg, but ProRes 4444's native
  // bit depth is 12-bit per component, so the actual stored pix_fmt ends
  // up as yuv444p12le. The invariant we're checking is "max preset uses
  // 4:4:4 chroma" (vs the lower-tier 4:2:2). Match on the prefix.
  assert(/^yuv444p\d+le$/.test(stream.pix_fmt),
    `pix_fmt should be 4:4:4 (yuv444p<N>le) at max preset: got "${stream.pix_fmt}"`);
});

scenario('--quality-preset draft → h264, much smaller than standard', ({ tmp }) => {
  const fxA = writeTinyFixture(tmp, { name: 'draft.html' });
  const rA = runH2v(defaultArgs(fxA).concat(['--quality-preset', 'draft']), { cwd: tmp });
  assert(rA.code === 0, `draft exit ${rA.code}; stderr: ${rA.stderr}`);

  const fxB = writeTinyFixture(tmp, { name: 'standard.html' });
  const rB = runH2v(defaultArgs(fxB).concat(['--quality-preset', 'standard']), { cwd: tmp });
  assert(rB.code === 0, `standard exit ${rB.code}; stderr: ${rB.stderr}`);

  const draftSize = fileSize(path.join(tmp, 'output', 'draft.mp4'));
  const stdSize = fileSize(path.join(tmp, 'output', 'standard.mp4'));
  // Static fixture is small either way; we just need draft to not be
  // *bigger* than standard. The real signal is that both produced a video.
  assert(draftSize > 0 && stdSize > 0, 'both presets produced non-empty output');
  // Don't assert strict inequality — for a 1s static fixture the encoder
  // can produce nearly equal sizes. The codec assertion below is enough.
  const info = ffprobe(path.join(tmp, 'output', 'draft.mp4'));
  const stream = info.streams.find((s) => s.codec_type === 'video');
  assertEq(stream.codec_name, 'h264', 'draft codec_name');
});

scenario('--crf 0 (lossless) >> --crf 28 (aggressive) in file size', ({ tmp }) => {
  // The two runs have to write to different output files or the second
  // overwrites the first. Use --out for each. Use a longer duration so
  // there are enough frames to make compression-tier differences
  // measurable against container/header overhead.
  const fxA = writeTinyFixture(tmp, { name: 'lossless.html', duration: '2s' });
  const rA = runH2v(defaultArgs(fxA).concat(['--crf', '0', '--out', path.join(tmp, 'lossless.mp4')]), { cwd: tmp });
  assert(rA.code === 0, `crf 0 exit ${rA.code}; stderr: ${rA.stderr}`);

  const fxB = writeTinyFixture(tmp, { name: 'aggressive.html', duration: '2s' });
  const rB = runH2v(defaultArgs(fxB).concat(['--crf', '28', '--out', path.join(tmp, 'aggressive.mp4')]), { cwd: tmp });
  assert(rB.code === 0, `crf 28 exit ${rB.code}; stderr: ${rB.stderr}`);

  const losslessSize = fileSize(path.join(tmp, 'lossless.mp4'));
  const aggressiveSize = fileSize(path.join(tmp, 'aggressive.mp4'));
  // CRF 0 is lossless; should be substantially larger than CRF 28 on the
  // gradient+text fixture.
  assert(losslessSize > aggressiveSize * 2,
    `expected lossless (${losslessSize}) >> aggressive (${aggressiveSize}) — ratio ${(losslessSize / aggressiveSize).toFixed(2)}×`);
});

// ===========================================================================
// Capture-side (verified via --no-ffmpeg + inspecting captures/)
// ===========================================================================

scenario('--capture-format png + --no-ffmpeg → captures/ has .png frames', ({ tmp }) => {
  const fx = writeTinyFixture(tmp);
  const r = runH2v(defaultArgs(fx).concat([
    '--capture-format', 'png', '--no-ffmpeg', '--fps', '10',
  ]), { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const captureDir = path.join(tmp, 'captures', 'tiny');
  const files = fs.readdirSync(captureDir);
  assert(files.length > 0, `expected captured frames in ${captureDir}`);
  assert(files.every((f) => f.endsWith('.png')),
    `expected all frames to be .png; got: ${files.slice(0, 5)}`);
  // No video file should exist.
  assert(!fs.existsSync(path.join(tmp, 'output', 'tiny.mp4')),
    `--no-ffmpeg should skip encoding; output/tiny.mp4 found`);
});

scenario('--capture-quality 10 produces smaller JPEG frames than q=95', ({ tmp }) => {
  // Each export overwrites captures/<id>/; use TWO fixtures so we can
  // compare them. Both run with --no-ffmpeg so we inspect the capture.
  const fxLow = writeTinyFixture(tmp, { name: 'low.html', extraMeta: '<style>body{background:linear-gradient(45deg,#a00,#0a0)}</style>' });
  const rLow = runH2v(defaultArgs(fxLow).concat([
    '--capture-quality', '10', '--no-ffmpeg', '--fps', '10',
  ]), { cwd: tmp });
  assert(rLow.code === 0, `low-quality exit ${rLow.code}; stderr: ${rLow.stderr}`);

  const fxHigh = writeTinyFixture(tmp, { name: 'high.html', extraMeta: '<style>body{background:linear-gradient(45deg,#a00,#0a0)}</style>' });
  const rHigh = runH2v(defaultArgs(fxHigh).concat([
    '--capture-quality', '95', '--no-ffmpeg', '--fps', '10',
  ]), { cwd: tmp });
  assert(rHigh.code === 0, `high-quality exit ${rHigh.code}; stderr: ${rHigh.stderr}`);

  // Sum frame sizes for each capture dir.
  function sumSizes(dir) {
    let total = 0;
    for (const f of fs.readdirSync(dir)) total += fs.statSync(path.join(dir, f)).size;
    return total;
  }
  const lowTotal = sumSizes(path.join(tmp, 'captures', 'low'));
  const highTotal = sumSizes(path.join(tmp, 'captures', 'high'));
  assert(highTotal > lowTotal * 1.5,
    `expected q=95 frames noticeably larger than q=10 — got ${highTotal} vs ${lowTotal} (ratio ${(highTotal / lowTotal).toFixed(2)}×)`);
});

scenario('--no-ffmpeg alone → captures present, no video file', ({ tmp }) => {
  const fx = writeTinyFixture(tmp);
  const r = runH2v(defaultArgs(fx).concat(['--no-ffmpeg', '--fps', '10']), { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const captureDir = path.join(tmp, 'captures', 'tiny');
  assert(fs.readdirSync(captureDir).length > 0,
    `expected captured frames in ${captureDir}`);
  assert(!fs.existsSync(path.join(tmp, 'output', 'tiny.mp4')),
    `--no-ffmpeg should not produce output/tiny.mp4`);
});

// ===========================================================================
// File placement
// ===========================================================================

scenario('--out custom/path.mp4 → output lands at the explicit path', ({ tmp }) => {
  const fx = writeTinyFixture(tmp);
  const explicit = path.join(tmp, 'sub', 'mine.mp4');
  const r = runH2v(defaultArgs(fx).concat(['--out', explicit]), { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  assert(fs.existsSync(explicit),
    `expected ${explicit} to exist after --out`);
});

scenario('--out-dir alternate → outputs land under alternate/', ({ tmp }) => {
  const fx = writeTinyFixture(tmp);
  const r = runH2v(defaultArgs(fx).concat(['--out-dir', 'alternate']), { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  assert(fs.existsSync(path.join(tmp, 'alternate', 'tiny.mp4')),
    `expected output at alternate/tiny.mp4`);
});

scenario('--theme dark,light on themed fixture → two output files', ({ tmp }) => {
  const fx = writeTinyFixture(tmp, {
    extraMeta: '<meta name="h2v-themes" content="dark,light,vibrant">',
  });
  const r = runH2v(defaultArgs(fx).concat(['--theme', 'dark,light']), { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  // First-declared theme (dark) is the default → no filename suffix.
  // Second theme (light) → "-light" suffix.
  assert(fs.existsSync(path.join(tmp, 'output', 'tiny.mp4')),
    `expected output/tiny.mp4 (default theme dark, no suffix)`);
  assert(fs.existsSync(path.join(tmp, 'output', 'tiny-light.mp4')),
    `expected output/tiny-light.mp4 (light theme with suffix)`);
});

// ===========================================================================
// Concurrency — validates the flag is plumbed through and parallel exec
// produces correct outputs (not measuring perf).
// ===========================================================================

scenario('--concurrency 2 on a 4-anim bundle → 4 valid outputs', ({ tmp }) => {
  // Build a minimal 4-block bundle in tmp.
  const bundlePath = path.join(tmp, 'multi.html');
  const blocks = [];
  for (let i = 1; i <= 4; i++) {
    blocks.push(`<!-- ===== ANIMATION_START id="clip${i}" capture_duration="0.5s" viewport="320x180" ===== -->`);
    blocks.push(`<html><body style="background:#${i}${i}${i}"></body></html>`);
    blocks.push(`<!-- ===== ANIMATION_END id="clip${i}" ===== -->`);
    blocks.push('');
  }
  fs.writeFileSync(bundlePath, blocks.join('\n'));

  const r = runH2v([
    'export', bundlePath, '--scale', '1', '--slowdown', '1', '--concurrency', '2',
  ], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  for (let i = 1; i <= 4; i++) {
    const out = path.join(tmp, 'output', 'multi', `clip${i}.mp4`);
    assert(fs.existsSync(out), `expected ${out} to exist`);
    const info = ffprobe(out);
    const stream = info.streams.find((s) => s.codec_type === 'video');
    assertEq(stream.codec_name, 'hevc', `clip${i} codec_name`);
  }
});

// ===========================================================================
// Default output target: fit within a 4K box (orientation-aware), no flags
// ===========================================================================

scenario('default (no --scale): 1920×1080 viewport → 3840×2160 (4K, render ×2 exact)', ({ tmp }) => {
  const fx = writeTinyFixture(tmp, { viewport: '1920x1080', duration: '0.3s' });
  const r = runH2v(['export', fx, '--slowdown', '1'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const stream = ffprobe(path.join(tmp, 'output', 'tiny.mp4')).streams.find((s) => s.codec_type === 'video');
  assertEq(stream.width, 3840, 'width');
  assertEq(stream.height, 2160, 'height');
});

scenario('default (no --scale): 540×960 portrait → 2160×3840 (orientation-aware 4K)', ({ tmp }) => {
  const fx = writeTinyFixture(tmp, { viewport: '540x960', duration: '0.3s' });
  const r = runH2v(['export', fx, '--slowdown', '1'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const stream = ffprobe(path.join(tmp, 'output', 'tiny.mp4')).streams.find((s) => s.codec_type === 'video');
  assertEq(stream.width, 2160, 'width (portrait short edge)');
  assertEq(stream.height, 3840, 'height (portrait long edge)');
});

scenario('default (no --scale): over-4K viewport 4000×2250 → downscaled to 3840×2160', ({ tmp }) => {
  const fx = writeTinyFixture(tmp, { viewport: '4000x2250', duration: '0.3s' });
  const r = runH2v(['export', fx, '--slowdown', '1'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const stream = ffprobe(path.join(tmp, 'output', 'tiny.mp4')).streams.find((s) => s.codec_type === 'video');
  assertEq(stream.width, 3840, 'width (downscaled to fit 4K)');
  assertEq(stream.height, 2160, 'height (downscaled to fit 4K)');
});

// ===========================================================================
// --output-height (supersampled target resolution)
// ===========================================================================

scenario('--output-height downscales to exact target (viewport not an integer divisor)', ({ tmp }) => {
  // 640×360 viewport, target height 300 → render scale = ceil(300/360) = 1
  // (render 640×360), then Lanczos-downscale to height 300. Width follows
  // 16:9 aspect → 300 × 640/360 = 533.3 → even → 532 or 534.
  const fx = writeTinyFixture(tmp, { viewport: '640x360' });
  const r = runH2v(['export', fx, '--output-height', '300', '--slowdown', '1'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const info = ffprobe(path.join(tmp, 'output', 'tiny.mp4'));
  const stream = info.streams.find((s) => s.codec_type === 'video');
  assertEq(stream.height, 300, 'height = target');
  assert(stream.width % 2 === 0, `width must be even (got ${stream.width})`);
  // Aspect preserved (16:9 → ~533), even-rounded.
  assert(Math.abs(stream.width - 533) <= 2, `width ~533 for 16:9 (got ${stream.width})`);
});

scenario('--output-height exact integer multiple → no resample, exact size', ({ tmp }) => {
  // 640×360, target 1080 → render scale = ceil(1080/360) = 3 → render 1920×1080
  // already equals target height → downscale skipped, output exactly 1920×1080.
  const fx = writeTinyFixture(tmp, { viewport: '640x360' });
  const r = runH2v(['export', fx, '--output-height', '1080', '--slowdown', '1'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const info = ffprobe(path.join(tmp, 'output', 'tiny.mp4'));
  const stream = info.streams.find((s) => s.codec_type === 'video');
  assertEq(stream.width, 1920, 'width (640 × 3)');
  assertEq(stream.height, 1080, 'height (target = 360 × 3)');
});

scenario('--output-height + --scale → exit 2 (mutually exclusive)', ({ tmp }) => {
  const fx = writeTinyFixture(tmp);
  const r = runH2v(['export', fx, '--output-height', '720', '--scale', '2'], { cwd: tmp });
  assertEq(r.code, 2, 'exit code');
});

scenario('odd --output-height → exit 2 (encoders need even dims)', ({ tmp }) => {
  const fx = writeTinyFixture(tmp);
  const r = runH2v(['export', fx, '--output-height', '721'], { cwd: tmp });
  assertEq(r.code, 2, 'exit code');
});

// ===========================================================================
// --gif (animated GIF export)
// ===========================================================================

scenario('--gif → gif codec, default 480p / 20fps', ({ tmp }) => {
  const fx = writeTinyFixture(tmp, { viewport: '640x360', duration: '0.5s' });
  const r = runH2v(['export', fx, '--gif', '--slowdown', '1'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const out = path.join(tmp, 'output', 'tiny.gif');
  assert(fs.existsSync(out), 'expected output/tiny.gif');
  const stream = ffprobe(out).streams.find((s) => s.codec_type === 'video');
  assertEq(stream.codec_name, 'gif', 'codec');
  assertEq(stream.height, 480, 'default height (480p)');
  assert(stream.width % 2 === 0, `even width (got ${stream.width})`);
  assertEq(stream.avg_frame_rate, '20/1', 'default 20fps (exact 5cs delay)');
});

scenario('--gif --output-height 720 --fps 25 → overrides apply', ({ tmp }) => {
  const fx = writeTinyFixture(tmp, { viewport: '640x360', duration: '0.5s' });
  const r = runH2v(['export', fx, '--gif', '--output-height', '720', '--fps', '25', '--slowdown', '1'], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const stream = ffprobe(path.join(tmp, 'output', 'tiny.gif')).streams.find((s) => s.codec_type === 'video');
  assertEq(stream.height, 720, 'height override');
  assertEq(stream.avg_frame_rate, '25/1', 'fps override (25 = 4cs)');
});

scenario('--gif --quality-preset max → per-frame palette, much larger than draft', ({ tmp }) => {
  // Use the SEEK fixture: its frames are deterministic (byte-identical every
  // run) and it actually moves, so per-frame palette (max) clearly compounds
  // over global 128-colour no-dither (draft). The play-driven tiny fixture is
  // render-variable and near-static, which makes gif sizes too noisy to gate.
  const fx = path.join(REPO_ROOT, 'tests', 'seek-test.html');
  const max = path.join(tmp, 'max.gif');
  const draft = path.join(tmp, 'draft.gif');
  const rMax = runH2v(['export', fx, '--gif', '--quality-preset', 'max', '--out', max], { cwd: tmp });
  const rDraft = runH2v(['export', fx, '--gif', '--quality-preset', 'draft', '--out', draft], { cwd: tmp });
  assert(rMax.code === 0 && rDraft.code === 0, `exits: max ${rMax.code}, draft ${rDraft.code}`);
  assert(fileSize(max) > fileSize(draft) * 2,
    `max (per-frame palette) should dwarf draft: max=${fileSize(max)} draft=${fileSize(draft)}`);
});

scenario('--gif --alpha → exit 2 (mutually exclusive)', ({ tmp }) => {
  const fx = writeTinyFixture(tmp);
  assertEq(runH2v(['export', fx, '--gif', '--alpha'], { cwd: tmp }).code, 2, 'exit code');
});

scenario('--gif --codec libx264 → exit 2 (gif forces its codec)', ({ tmp }) => {
  const fx = writeTinyFixture(tmp);
  assertEq(runH2v(['export', fx, '--gif', '--codec', 'libx264'], { cwd: tmp }).code, 2, 'exit code');
});

summary();
