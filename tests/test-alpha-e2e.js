#!/usr/bin/env node
//
// End-to-end correctness tests for `h2v export --alpha`. Validates the
// "couples four options" invariant from CLAUDE.md at the output level:
// each --alpha variant produces a real .mov with a real alpha channel
// and the documented codec/pix_fmt for that variant.
//
// Plus a pixel-level check that --alpha-mode actually changes the bytes
// in the output (pre-multiplied vs straight).
//
//   node tests/test-alpha-e2e.js
//   npm run test:alpha-e2e

const fs = require('fs');
const path = require('path');
const {
  REPO_ROOT,
  scenario,
  assert,
  assertEq,
  runH2v,
  ffprobe,
  extractFrameRgba,
  summary,
} = require('./_test-harness');

// Use the committed alpha-test fixture — it's tiny (1.5s, pink "alpha"
// text fading in over a transparent body) and known to exercise the
// alpha path. Recording at 320×180 keeps each export under ~3 s.
const ALPHA_FIXTURE = 'tests/alpha-test.html';
const VW = 320, VH = 180;

// Find a semi-transparent pixel in the frame and return {r, g, b, a}.
// Returns null if no semi-transparent pixel is found (which would itself
// indicate a broken alpha path).
function findSemiTransparentPixel(buf) {
  for (let i = 0; i < buf.length; i += 4) {
    const a = buf[i + 3];
    if (a > 5 && a < 250) {
      return { r: buf[i], g: buf[i + 1], b: buf[i + 2], a };
    }
  }
  return null;
}

console.log('test-alpha-e2e.js — --alpha end-to-end validation');
console.log('');

// ---------------------------------------------------------------------------
// 1. Default --alpha → qtrle in .mov, argb pixel format.
//    Output framerate must default to alphaFps (30).
// ---------------------------------------------------------------------------
scenario('--alpha (default) → qtrle / argb / .mov / fps 30', ({ tmp }) => {
  const out = path.join(tmp, 'out.mov');
  const r = runH2v([
    'export', ALPHA_FIXTURE,
    '--width', String(VW), '--height', String(VH), '--scale', '1',
    '--slowdown', '1',
    '--alpha',
    '--out', out,
  ], { cwd: REPO_ROOT });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);

  assert(fs.existsSync(out), `expected ${out} to exist`);
  const info = ffprobe(out);
  const stream = info.streams.find((s) => s.codec_type === 'video');
  assertEq(stream.codec_name, 'qtrle', 'default --alpha codec is qtrle');
  assertEq(stream.pix_fmt, 'argb', 'qtrle pix_fmt is argb');
  assertEq(stream.r_frame_rate, '30/1', '--alpha defaults fps to 30');
  // Container check via format_name (should include "mov").
  assert(/mov/.test(info.format.format_name),
    `format_name should include "mov": ${info.format.format_name}`);
});

// ---------------------------------------------------------------------------
// 2. Default --alpha output actually contains real transparency.
//    Without this, codec/pix_fmt could lie — the file is alpha-capable
//    but the alpha plane is uniformly 255.
// ---------------------------------------------------------------------------
scenario('--alpha output has real per-pixel transparency', ({ tmp }) => {
  const out = path.join(tmp, 'transparency.mov');
  const r = runH2v([
    'export', ALPHA_FIXTURE,
    '--width', String(VW), '--height', String(VH), '--scale', '1',
    '--slowdown', '1',
    '--alpha',
    '--out', out,
  ], { cwd: REPO_ROOT });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);

  // The fixture fades in pink text over a transparent body. At t=0 the
  // text has opacity 0 — entire frame is transparent. Sample frame at t=0
  // and assert the alpha channel is uniformly 0 (or at most a few px have
  // non-zero alpha due to anti-aliasing edge cases).
  const startFrame = extractFrameRgba(out, 0.05);
  let opaqueAtStart = 0;
  for (let i = 0; i < startFrame.length; i += 4) {
    if (startFrame[i + 3] > 200) opaqueAtStart++;
  }
  const totalPixels = startFrame.length / 4;
  // At t≈0 with opacity:0 text, we expect ≪ 1% of pixels to be near-opaque.
  assert(opaqueAtStart < totalPixels * 0.01,
    `at t=0 expected near-zero opaque pixels; got ${opaqueAtStart}/${totalPixels}`);

  // At t≈1.0 the text has fully faded in. There should be a non-trivial
  // number of opaque pixels (the text glyphs).
  const lateFrame = extractFrameRgba(out, 1.0);
  let opaqueAtLate = 0;
  for (let i = 0; i < lateFrame.length; i += 4) {
    if (lateFrame[i + 3] > 200) opaqueAtLate++;
  }
  assert(opaqueAtLate > 50,
    `at t=1.0 expected text pixels to be opaque; got only ${opaqueAtLate}`);
});

// ---------------------------------------------------------------------------
// 3. --alpha --codec prores_ks → prores stream with alpha (yuva444p10le).
// ---------------------------------------------------------------------------
scenario('--alpha --codec prores_ks → prores yuva444p10le', ({ tmp }) => {
  const out = path.join(tmp, 'prores.mov');
  const r = runH2v([
    'export', ALPHA_FIXTURE,
    '--width', String(VW), '--height', String(VH), '--scale', '1',
    '--slowdown', '1',
    '--alpha', '--codec', 'prores_ks',
    '--out', out,
  ], { cwd: REPO_ROOT });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);

  const info = ffprobe(out);
  const stream = info.streams.find((s) => s.codec_type === 'video');
  assertEq(stream.codec_name, 'prores', 'codec_name');
  // h2v passes `-pix_fmt yuva444p10le` to ffmpeg, but ProRes 4444's
  // native bit depth is 12-bit per component, so the stored pix_fmt
  // ends up as yuva444p12le. The invariant we're checking is "ProRes
  // with alpha plane at 4:4:4 chroma" — match on prefix.
  assert(/^yuva444p\d+le$/.test(stream.pix_fmt),
    `pix_fmt should be yuva444p<N>le (ProRes 4444 + alpha): got "${stream.pix_fmt}"`);
});

// ---------------------------------------------------------------------------
// 4. --alpha --codec png → png-in-MOV with rgba.
// ---------------------------------------------------------------------------
scenario('--alpha --codec png → png-in-MOV with rgba', ({ tmp }) => {
  const out = path.join(tmp, 'pngmov.mov');
  const r = runH2v([
    'export', ALPHA_FIXTURE,
    '--width', String(VW), '--height', String(VH), '--scale', '1',
    '--slowdown', '1',
    '--alpha', '--codec', 'png',
    '--out', out,
  ], { cwd: REPO_ROOT });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);

  const info = ffprobe(out);
  const stream = info.streams.find((s) => s.codec_type === 'video');
  assertEq(stream.codec_name, 'png', 'codec_name');
  assertEq(stream.pix_fmt, 'rgba', 'pix_fmt (PNG-in-MOV with alpha)');
});

// ---------------------------------------------------------------------------
// 5. --alpha-mode pre-multiplied (default) vs straight produce DIFFERENT
//    pixel values. The pre-mult path bakes RGB×α into the file via
//    ffmpegStitch's `-vf premultiply=inplace=1`; the straight path
//    leaves RGB at full strength. The signal: for a semi-transparent
//    pixel, R/α should be ≪ 2 in pre-mult (often ≈ 1) and >> 2 in
//    straight (often ≈ the original RGB value when α is small).
// ---------------------------------------------------------------------------
scenario('--alpha-mode pre-mult vs straight: pixel values differ', ({ tmp }) => {
  const premultOut = path.join(tmp, 'premult.mov');
  const straightOut = path.join(tmp, 'straight.mov');

  const baseArgs = [
    'export', ALPHA_FIXTURE,
    '--width', String(VW), '--height', String(VH), '--scale', '1',
    '--slowdown', '1',
    '--alpha',
  ];

  const r1 = runH2v(baseArgs.concat(['--out', premultOut]), { cwd: REPO_ROOT });
  assert(r1.code === 0, `pre-mult exit ${r1.code}; stderr: ${r1.stderr}`);
  const r2 = runH2v(baseArgs.concat(['--alpha-mode', 'straight', '--out', straightOut]),
    { cwd: REPO_ROOT });
  assert(r2.code === 0, `straight exit ${r2.code}; stderr: ${r2.stderr}`);

  // Sample at t=0.5s — partway through the fade-in, plenty of semi-
  // transparent pixels around the text glyphs.
  const premultFrame = extractFrameRgba(premultOut, 0.5);
  const straightFrame = extractFrameRgba(straightOut, 0.5);

  // Statistical comparison instead of per-pixel pairing. Each export
  // independently samples the same animation at the same wall-time, but
  // encoding noise (and slight frame-time drift between two runs) means
  // exact pixel-pair equality is unreliable. Instead:
  //   - Walk both frames; collect R/α ratios for all semi-transparent pixels.
  //   - In pre-mult: ratios cluster near 1 (RGB has been multiplied by α).
  //   - In straight:  ratios cluster much higher (R stays near 255).
  //   - The medians of the two distributions must differ by a clear margin.
  function ratios(buf) {
    const out = [];
    for (let i = 0; i < buf.length; i += 4) {
      const a = buf[i + 3];
      // Look at pixels with moderate-to-low α (the text fade is at ~33%
      // opacity at t=0.5s of a 1.5s fade-in, so most text pixels have
      // α in the 50-100 range).
      if (a > 20 && a < 150) {
        const r = buf[i];
        if (r > 5) out.push(r / a);  // skip black/transparent edges
      }
    }
    return out;
  }
  function median(arr) {
    if (arr.length === 0) return NaN;
    const sorted = arr.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  const premultRatios = ratios(premultFrame);
  const straightRatios = ratios(straightFrame);
  assert(premultRatios.length > 50,
    `pre-mult frame should have many semi-transparent pixels; found ${premultRatios.length}`);
  assert(straightRatios.length > 50,
    `straight frame should have many semi-transparent pixels; found ${straightRatios.length}`);

  const premultMedian = median(premultRatios);
  const straightMedian = median(straightRatios);
  // Pre-mult: R ≈ α (text is mostly-R), so R/α ≈ 1. Straight: R stays at
  // ~255, so R/α is much higher (e.g. 3+ when α≈85).
  assert(straightMedian > premultMedian * 2,
    `straight median R/α (${straightMedian.toFixed(2)}) should exceed pre-mult median (${premultMedian.toFixed(2)}) × 2`);
});

summary();
