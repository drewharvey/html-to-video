#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PKG = require('./package.json');
const VERSION = PKG.version || '0.0.0';

const DEFAULTS = {
  fps: 60,
  width: 1280,
  height: 720,
  scale: 3,
  crf: 18,
  duration: 10,
  slowdown: 10,
  outDir: 'output',
};

const SKIP_FILENAMES = new Set(['review.html']);

// Bundle marker syntax: ANIMATION_START / ANIMATION_END.
// We also accept the older FRAME_START / FRAME_END for backward
// compatibility with bundles authored before the rename.
const ANIMATION_BLOCK_RE =
  /<!--\s*=+\s*(?:ANIMATION|FRAME)_START\s+(.*?)\s*=+\s*-->\s*([\s\S]*?)\s*<!--\s*=+\s*(?:ANIMATION|FRAME)_END\b[^>]*?-->/g;
const ANIMATION_START_PROBE = /<!--\s*=+\s*(?:ANIMATION|FRAME)_START\b/;
const META_DURATION_RE =
  /<meta\s+name=["']h2v-duration["']\s+content=["']?(\d+(?:\.\d+)?)\s*s?["']?\s*\/?>/i;
const ATTR_RE = /(\w+)="([^"]*)"/g;

// =========================================================================
// Help & version
// =========================================================================

const HELP_TEXT = `h2v v${VERSION} — record and preview HTML animations

USAGE
  h2v export [<paths...>] [flags]   Record animations as 4K MP4s
  h2v review [<paths...>] [flags]   Build a single HTML page that previews
                                    every animation at the given paths
  h2v --help
  h2v --version

ARGUMENTS
  paths     One or more HTML files or directories. With no paths, every
            *.html in the current directory is processed (non-recursive).
            Files inside an explicitly named directory are filtered with
            the same rules: dotfiles and review.html are skipped.

EXPORT FLAGS
  --duration <Ns>     Single-file capture duration when no <meta> tag is
                      present (default: ${DEFAULTS.duration}s). Bundles
                      ignore this; they use each marker's capture_duration.
  --fps <N>           Frames per second (default: ${DEFAULTS.fps}).
  --width <N>         Viewport width in CSS pixels (default: ${DEFAULTS.width}).
  --height <N>        Viewport height in CSS pixels (default: ${DEFAULTS.height}).
  --scale <N>         Device scale factor (default: ${DEFAULTS.scale};
                      1280×720 × 3 = 4K).
  --crf <N>           x264 CRF (default: ${DEFAULTS.crf}; lower = bigger/better;
                      18 is visually lossless).
  --slowdown <N>      Real-time slowdown factor (default: ${DEFAULTS.slowdown}). The browser
                      runs animations at 1/N speed so screenshots can keep
                      up; the resulting MP4 plays back at original speed.
                      Total recording wall time = animation duration × N.
                      Use 1 to disable (only works if screenshots fit in
                      one frame interval, ~16 ms at 60 fps).
  --theme <m>         dark | light | both (default: dark). 'both' produces
                      two MP4s per animation; light has a -light suffix.
  --out-dir <path>    Output directory (default: ./${DEFAULTS.outDir}).
  --out <path>        Exact output filename. Only valid when exactly one
                      MP4 will be produced.
  --no-ffmpeg         Capture PNGs only; skip stitching and the captures
                      cleanup step.
  --dry-run           Print the recording plan and exit (no browser needed).

REVIEW FLAGS
  --out <path>        Write the review page to this path instead of a
                      tmpfile (implies --keep).
  --no-open           Don't auto-open the browser; just print the path.
                      (No auto-cleanup either.)
  --keep              Don't delete the temp file on exit. (Implied by
                      --out and --no-open.)

SHARED FLAGS
  -h, --help          Show this help.
  --version           Show version.

PER-FILE METADATA
  Add <meta name="h2v-duration" content="Ns"> in the <head> of a
  single-file animation to set its capture duration. The value is in
  seconds and may be an integer or a decimal.

ENVIRONMENT
  PUPPETEER_EXECUTABLE_PATH  Browser executable path. Useful when
                             puppeteer's bundled Chrome isn't compatible
                             with the host (e.g. ARM64 Linux).
`;

function printHelp() {
  process.stdout.write(HELP_TEXT);
}

// =========================================================================
// Argument parsing
// =========================================================================

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }
  if (args[0] === '--version') {
    console.log(VERSION);
    process.exit(0);
  }

  const [command, ...rest] = args;
  if (command !== 'export' && command !== 'review') {
    console.error(`error: unknown command: ${command}`);
    console.error(`Did you mean: h2v export ${args.join(' ')} ?`);
    process.exit(2);
  }

  const positional = [];
  const opts = {
    command,
    duration: DEFAULTS.duration,
    fps: DEFAULTS.fps,
    width: DEFAULTS.width,
    height: DEFAULTS.height,
    scale: DEFAULTS.scale,
    crf: DEFAULTS.crf,
    slowdown: DEFAULTS.slowdown,
    themes: ['dark'],
    outDir: DEFAULTS.outDir,
    outOverride: null,
    skipFfmpeg: false,
    dryRun: false,
    skipOpen: false,
    keep: false,
  };

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const requireValue = (label) => {
      const v = rest[++i];
      if (v === undefined) {
        console.error(`error: ${label} requires a value`);
        process.exit(2);
      }
      return v;
    };
    if (a === '--duration') opts.duration = parseDurationFlag(requireValue('--duration'));
    else if (a === '--fps') opts.fps = parsePositiveInt(requireValue('--fps'), '--fps');
    else if (a === '--width') opts.width = parsePositiveInt(requireValue('--width'), '--width');
    else if (a === '--height') opts.height = parsePositiveInt(requireValue('--height'), '--height');
    else if (a === '--scale') opts.scale = parsePositiveInt(requireValue('--scale'), '--scale');
    else if (a === '--crf') opts.crf = parseIntInRange(requireValue('--crf'), '--crf', 0, 51);
    else if (a === '--slowdown') opts.slowdown = parsePositiveInt(requireValue('--slowdown'), '--slowdown');
    else if (a === '--theme') opts.themes = parseThemeFlag(requireValue('--theme'));
    else if (a === '--out-dir') opts.outDir = requireValue('--out-dir');
    else if (a === '--out') opts.outOverride = requireValue('--out');
    else if (a === '--no-ffmpeg') opts.skipFfmpeg = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-open') opts.skipOpen = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a.startsWith('-')) {
      console.error(`error: unknown flag: ${a}`);
      process.exit(2);
    } else {
      positional.push(a);
    }
  }

  return { paths: positional, opts };
}

function parseDurationFlag(s) {
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*s?$/i);
  if (!m) {
    console.error(`error: invalid duration: ${s}`);
    process.exit(2);
  }
  const n = parseFloat(m[1]);
  if (n <= 0) {
    console.error(`error: duration must be > 0`);
    process.exit(2);
  }
  return n;
}

function parsePositiveInt(s, label) {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`error: ${label} must be a positive integer (got: ${s})`);
    process.exit(2);
  }
  return n;
}

function parseIntInRange(s, label, min, max) {
  const n = Number(s);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`error: ${label} must be an integer in [${min}..${max}] (got: ${s})`);
    process.exit(2);
  }
  return n;
}

function parseThemeFlag(s) {
  if (s === 'dark') return ['dark'];
  if (s === 'light') return ['light'];
  if (s === 'both') return ['dark', 'light'];
  console.error(`error: --theme must be dark, light, or both (got: ${s})`);
  process.exit(2);
}

// =========================================================================
// Input discovery
// =========================================================================

function discoverInputs(paths, cwd) {
  const inputs = new Set();
  if (paths.length === 0) {
    listHtmlInDir(cwd).forEach((p) => inputs.add(p));
    return [...inputs].sort();
  }
  for (const arg of paths) {
    const abs = path.resolve(cwd, arg);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (err) {
      console.error(`error: path not found: ${arg}`);
      process.exit(1);
    }
    if (stat.isFile()) {
      if (!abs.toLowerCase().endsWith('.html')) {
        console.error(`error: not an HTML file: ${arg}`);
        process.exit(1);
      }
      inputs.add(abs);
    } else if (stat.isDirectory()) {
      listHtmlInDir(abs).forEach((p) => inputs.add(p));
    } else {
      console.error(`error: not a file or directory: ${arg}`);
      process.exit(1);
    }
  }
  return [...inputs].sort();
}

function listHtmlInDir(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    if (SKIP_FILENAMES.has(entry)) continue;
    if (!entry.toLowerCase().endsWith('.html')) continue;
    const abs = path.resolve(dir, entry);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.isFile()) out.push(abs);
  }
  return out;
}

// =========================================================================
// Mode detection & parsing
// =========================================================================

function detectMode(htmlText) {
  return ANIMATION_START_PROBE.test(htmlText) ? 'bundle' : 'single';
}

function parseAttributes(attrString) {
  const out = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrString)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

function parseBundleFrames(htmlText, sourcePath) {
  const frames = [];
  let m;
  ANIMATION_BLOCK_RE.lastIndex = 0;
  while ((m = ANIMATION_BLOCK_RE.exec(htmlText)) !== null) {
    const attrs = parseAttributes(m[1]);
    if (!attrs.id) {
      throw new Error(`${sourcePath}: ANIMATION_START without id attribute`);
    }
    if (!attrs.capture_duration) {
      throw new Error(`${sourcePath}: ANIMATION_START id="${attrs.id}" missing capture_duration`);
    }
    const durMatch = attrs.capture_duration.match(/^(\d+(?:\.\d+)?)s?$/i);
    if (!durMatch) {
      throw new Error(`${sourcePath}: ANIMATION_START id="${attrs.id}" has invalid capture_duration "${attrs.capture_duration}"`);
    }
    frames.push({
      id: attrs.id,
      title: attrs.title || attrs.id,
      durationSeconds: parseFloat(durMatch[1]),
      html: m[2],
    });
  }
  if (frames.length === 0) {
    throw new Error(`${sourcePath}: bundle marker found but no complete ANIMATION_START/ANIMATION_END pair`);
  }
  return frames;
}

function extractMetaDuration(htmlText) {
  const m = htmlText.match(META_DURATION_RE);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n > 0 ? n : null;
}

// =========================================================================
// Plan construction
// =========================================================================

function buildPlan(inputs, opts) {
  const jobs = [];
  for (const inputPath of inputs) {
    const text = fs.readFileSync(inputPath, 'utf8');
    const mode = detectMode(text);
    const inputBase = path.basename(inputPath, path.extname(inputPath));

    if (mode === 'bundle') {
      const frames = parseBundleFrames(text, inputPath);
      for (const frame of frames) {
        for (const theme of opts.themes) {
          jobs.push(makeJob({
            inputPath, inputBase,
            mode: 'bundle',
            bundleId: frame.id,
            bundleTitle: frame.title,
            bundleHtml: frame.html,
            durationSeconds: frame.durationSeconds,
            theme,
          }, opts));
        }
      }
    } else {
      const meta = extractMetaDuration(text);
      const durationSeconds = meta != null ? meta : opts.duration;
      const durationSource = meta != null ? 'meta' : 'flag/default';
      for (const theme of opts.themes) {
        jobs.push(makeJob({
          inputPath, inputBase,
          mode: 'single',
          bundleId: null,
          bundleTitle: null,
          bundleHtml: null,
          durationSeconds,
          durationSource,
          theme,
        }, opts));
      }
    }
  }
  return jobs;
}

function makeJob(j, opts) {
  const totalFrames = Math.max(1, Math.round(j.durationSeconds * opts.fps));
  const themeSuffix = j.theme === 'light' ? '-light' : '';
  const captureKey = j.mode === 'bundle'
    ? `${j.inputBase}__${j.bundleId}${themeSuffix}`
    : `${j.inputBase}${themeSuffix}`;
  return {
    ...j,
    totalFrames,
    captureKey,
    label: j.mode === 'bundle'
      ? `[${j.inputBase}:${j.bundleId}${themeSuffix ? ' ' + j.theme : ''}]`
      : `[${j.inputBase}${themeSuffix ? ' ' + j.theme : ''}]`,
  };
}

function outputPathFor(job, opts) {
  const cwd = process.cwd();
  if (opts.outOverride) {
    return path.resolve(cwd, opts.outOverride);
  }
  const outDir = path.resolve(cwd, opts.outDir);
  const themeSuffix = job.theme === 'light' ? '-light' : '';
  if (job.mode === 'bundle') {
    return path.join(outDir, job.inputBase, `${job.bundleId}${themeSuffix}.mp4`);
  }
  return path.join(outDir, `${job.inputBase}${themeSuffix}.mp4`);
}

function validatePlan(jobs, opts) {
  if (opts.outOverride && jobs.length !== 1) {
    console.error(
      `error: --out can only be used when exactly one MP4 will be produced (this run produces ${jobs.length})`
    );
    process.exit(2);
  }
  // Detect duplicate output paths (could happen with same basename in different dirs).
  const seen = new Map();
  for (const job of jobs) {
    const out = outputPathFor(job, opts);
    if (seen.has(out)) {
      console.error(
        `error: two animations would write to the same output path: ${out}`
      );
      console.error(`  - ${seen.get(out)}`);
      console.error(`  - ${job.inputPath}${job.bundleId ? ` (${job.bundleId})` : ''}`);
      process.exit(1);
    }
    seen.set(out, `${job.inputPath}${job.bundleId ? ` (${job.bundleId})` : ''}`);
  }
}

// =========================================================================
// Plan summary
// =========================================================================

function relativeToHere(p) {
  const r = path.relative(process.cwd(), p);
  return r.startsWith('..') ? p : r;
}

function printPlan(jobs, opts) {
  if (jobs.length === 0) {
    console.log('No animations to record.');
    return;
  }
  const totalFrames = jobs.reduce((s, j) => s + j.totalFrames, 0);
  const totalSeconds = jobs.reduce((s, j) => s + j.durationSeconds, 0);
  console.log(
    `Plan: ${jobs.length} animation${jobs.length === 1 ? '' : 's'}, ` +
    `${totalFrames} frames at ${opts.fps}fps (~${totalSeconds.toFixed(1)}s of footage)`
  );
  for (const job of jobs) {
    const out = relativeToHere(outputPathFor(job, opts));
    const dur = `${job.durationSeconds}s`;
    const src = job.durationSource === 'meta' ? ' (from meta tag)' : '';
    console.log(
      `  ${job.label.padEnd(34)} ${dur.padStart(6)} × ${opts.fps}fps = ` +
      `${String(job.totalFrames).padStart(5)} frames → ${out}${src}`
    );
  }
}

// =========================================================================
// Time slowdown for synchronized JS + CSS animation capture
// =========================================================================
//
// Goal: capture N frames per second of an animation that "should" play at
// real-time speed. Screenshots are slow (4K PNGs take ~150 ms each), so we
// can't capture at the target framerate in real time without missing
// frames. The fix: slow EVERYTHING in the page by a factor S.
//
// 1. JS time sources are wrapped before any page script runs:
//    - `setTimeout`/`setInterval` delays are multiplied by S
//    - `performance.now()` returns "real elapsed since page load" / S
//    - `Date.now()` returns "page-load epoch + (real elapsed since page
//       load) / S"
//    - `requestAnimationFrame` callback timestamps are scaled the same way
//
// 2. CSS animations and transitions are slowed via the CDP Animation
//    domain: `Animation.setPlaybackRate({ playbackRate: 1 / S })`.
//
// Both layers slow at the same factor, so JS-driven and CSS-driven
// motion stay in lockstep. Then we capture frames at S × the target frame
// interval in real time (e.g. 100 ms real time per frame for 60 fps with
// S = 6). Each captured frame is at the correct moment of the original
// animation; output encoded at the target fps plays back at the original
// speed.
//
// Trade-off: total recording wall time = (animation duration) × S. The
// default S = 10 keeps recordings tolerable for short animations and
// gives screenshots plenty of time even at 4K.
//
// Caveat: this approach doesn't slow Workers, WebSockets, or fetch (none
// of which are typical in claude-generated animations).

const SHIM_SOURCE = `(function(sf) {
  if (sf === 1) return;
  var rST = window.setTimeout.bind(window);
  var rSI = window.setInterval.bind(window);
  window.setTimeout = function(fn, ms) {
    var args = Array.prototype.slice.call(arguments, 2);
    return rST.apply(null, [fn, (ms || 0) * sf].concat(args));
  };
  window.setInterval = function(fn, ms) {
    var args = Array.prototype.slice.call(arguments, 2);
    return rSI.apply(null, [fn, (ms || 1) * sf].concat(args));
  };
  var rPerf = performance.now.bind(performance);
  var perfStart = rPerf();
  Object.defineProperty(performance, 'now', {
    value: function() { return (rPerf() - perfStart) / sf; },
    configurable: true, writable: true,
  });
  var rDate = Date.now.bind(Date);
  var dateStart = rDate();
  Date.now = function() { return dateStart + (rDate() - dateStart) / sf; };
  var rRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function(cb) {
    return rRAF(function(realTs) { cb((realTs - perfStart) / sf); });
  };
})`;

// =========================================================================
// Recording
// =========================================================================

async function recordJob(browser, job, opts, capturesRoot) {
  const page = await browser.newPage();
  try {
    await page.setViewport({
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: opts.scale,
    });

    // Inject the JS time-slowdown shim before any page script runs.
    await page.evaluateOnNewDocument(`${SHIM_SOURCE}(${opts.slowdown});`);

    if (job.mode === 'bundle') {
      await page.setContent(job.bundleHtml, { waitUntil: 'load' });
    } else {
      await page.goto('file://' + job.inputPath, { waitUntil: 'load' });
    }

    // Slow CSS animations / transitions / Web Animations API entries
    // proportionally. Must be set after navigation so the timeline exists.
    const client = await page.target().createCDPSession();
    await client.send('Animation.enable');
    if (opts.slowdown !== 1) {
      await client.send('Animation.setPlaybackRate', {
        playbackRate: 1 / opts.slowdown,
      });
    }

    if (job.theme === 'light') {
      await page.evaluate(() =>
        document.documentElement.setAttribute('data-theme', 'light')
      );
    }

    const captureDir = path.join(capturesRoot, job.captureKey);
    fs.rmSync(captureDir, { recursive: true, force: true });
    fs.mkdirSync(captureDir, { recursive: true });

    // Pace screenshots at S × frame-interval real ms.
    const tickMsReal = (1000 / opts.fps) * opts.slowdown;
    const startReal = Date.now();
    for (let i = 1; i <= job.totalFrames; i++) {
      const target = startReal + i * tickMsReal;
      const wait = target - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const fileName = String(i).padStart(4, '0') + '.png';
      await page.screenshot({
        path: path.join(captureDir, fileName),
        type: 'png',
      });
      if (i % opts.fps === 0 || i === job.totalFrames) {
        process.stdout.write(`\r    captured ${i}/${job.totalFrames}`);
      }
    }
    process.stdout.write('\n');
    return captureDir;
  } finally {
    try { await page.close(); } catch { /* ignore cleanup errors */ }
  }
}

// =========================================================================
// FFmpeg
// =========================================================================

function ensureFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (r.error || r.status !== 0) {
    console.error(
      'error: ffmpeg not found on PATH. Install it (e.g. `brew install ffmpeg`) ' +
      'or pass --no-ffmpeg to capture PNGs only.'
    );
    process.exit(1);
  }
}

function ffmpegStitch(captureDir, outPath, opts) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const args = [
      '-y',
      '-loglevel', 'error',
      '-framerate', String(opts.fps),
      '-start_number', '1',
      '-i', path.join(captureDir, '%04d.png'),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', String(opts.crf),
      outPath,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    proc.on('error', reject);
    proc.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited with code ${code}`))
    );
  });
}

// =========================================================================
// Review command
// =========================================================================
//
// Build a single self-contained HTML page that embeds every animation
// from the given paths as <iframe srcdoc>. Default: write to a tmpfile,
// open it in the browser, wait for SIGINT, delete on exit.

function safeJsonForScript(value) {
  // JSON.stringify produces literal "</script>" inside any embedded
  // animation HTML, which would terminate the outer <script> tag.
  // Escape "</" → "<\/" — equivalent in a JS string, invisible to the
  // HTML tokenizer.
  return JSON.stringify(value, null, 2).replace(/<\/(?=[a-zA-Z!])/g, '<\\/');
}

function buildReviewHtml(animations) {
  const count = animations.length;
  const countLabel = `${count} animation${count === 1 ? '' : 's'}`;
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>h2v review — ${countLabel}</title>
<style>
:root {
  --bg: #0b0b0c; --card-bg: #161618; --border: #2a2a2d;
  --text: #e6e6e8; --muted: #9a9aa1; --accent: #056ff0;
  --btn-bg: #1f1f23; --btn-hover: #2a2a30;
}
[data-theme="light"] {
  --bg: #f4f4f5; --card-bg: #ffffff; --border: #d8d8dc;
  --text: #18181b; --muted: #6a6a72; --accent: #056ff0;
  --btn-bg: #ececef; --btn-hover: #dedee2;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg); color: var(--text);
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  min-height: 100vh; transition: background 0.2s ease, color 0.2s ease;
}
.page-header {
  position: sticky; top: 0; z-index: 50;
  background: var(--bg); border-bottom: 1px solid var(--border);
  padding: 14px 28px; display: flex; align-items: center;
  justify-content: space-between;
}
.page-header h1 { margin: 0; font-size: 16px; font-weight: 600; }
.page-header h1 small {
  color: var(--muted); font-weight: 400; margin-left: 8px; font-size: 13px;
}
.global-controls { display: flex; gap: 8px; }
button.ctl {
  padding: 8px 14px; background: var(--btn-bg); border: 1px solid var(--border);
  border-radius: 8px; color: var(--text); font-size: 13px; cursor: pointer;
  font-family: monospace;
}
button.ctl:hover { background: var(--btn-hover); }
main {
  max-width: 1100px; margin: 0 auto; padding: 24px 20px 80px;
  display: grid; gap: 24px;
}
.card {
  background: var(--card-bg); border: 1px solid var(--border);
  border-radius: 12px; overflow: hidden;
}
.card-head {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; border-bottom: 1px solid var(--border);
}
.card-head .name {
  font-size: 14px; font-weight: 600; flex: 1; font-family: monospace;
}
.card-head .source {
  font-family: monospace; font-size: 11px; color: var(--muted);
}
.card-head .replay {
  padding: 6px 12px; font-size: 12px; background: var(--btn-bg);
  border: 1px solid var(--border); border-radius: 6px; color: var(--text);
  cursor: pointer; font-family: monospace;
}
.card-head .replay:hover { background: var(--btn-hover); }
.frame-iframe {
  display: block; width: 100%; height: 480px; border: 0;
  background: var(--bg);
}
</style>
</head>
<body>
<header class="page-header">
  <h1>h2v review <small>${countLabel}</small></h1>
  <div class="global-controls">
    <button class="ctl" id="reloadAll">↻ Reload all</button>
    <button class="ctl" id="themeToggle">☀ Light</button>
  </div>
</header>
<main id="cards"></main>
<script>
const ANIMATIONS = ${safeJsonForScript(animations)};

let currentTheme = 'dark';

function injectTheme(html, theme) {
  const stripped = html.replace(/<html\\b([^>]*?)\\sdata-theme="[^"]*"([^>]*)>/i, '<html$1$2>');
  return stripped.replace(/<html\\b([^>]*)>/i, '<html$1 data-theme="' + theme + '">');
}
function loadFrame(iframe, html) { iframe.srcdoc = injectTheme(html, currentTheme); }
function broadcastTheme(theme) {
  document.querySelectorAll('iframe').forEach((f) => {
    try { f.contentWindow && f.contentWindow.postMessage({ theme: theme }, '*'); } catch (_) {}
  });
}
function setThemeButtonLabel() {
  document.getElementById('themeToggle').textContent =
    currentTheme === 'dark' ? '☀ Light' : '🌙 Dark';
}

const main = document.getElementById('cards');
ANIMATIONS.forEach((a) => {
  const card = document.createElement('article');
  card.className = 'card';
  const head = document.createElement('div');
  head.className = 'card-head';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = a.title || a.id;
  const source = document.createElement('span');
  source.className = 'source';
  source.textContent = a.source;
  const replay = document.createElement('button');
  replay.className = 'replay';
  replay.textContent = '↺ Replay';
  const iframe = document.createElement('iframe');
  iframe.className = 'frame-iframe';
  iframe.title = a.title || a.id;
  iframe.setAttribute('loading', 'lazy');
  replay.addEventListener('click', () => loadFrame(iframe, a.html));
  loadFrame(iframe, a.html);
  head.append(name, source, replay);
  card.append(head, iframe);
  main.appendChild(card);
});

document.getElementById('reloadAll').addEventListener('click', () => {
  document.querySelectorAll('.card').forEach((card, i) => {
    const iframe = card.querySelector('iframe');
    loadFrame(iframe, ANIMATIONS[i].html);
  });
});
document.getElementById('themeToggle').addEventListener('click', () => {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', currentTheme);
  setThemeButtonLabel();
  broadcastTheme(currentTheme);
});
setThemeButtonLabel();
</script>
</body>
</html>
`;
}

function openInBrowser(filePath) {
  const cmd =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'cmd' :
    'xdg-open';
  const args =
    process.platform === 'win32' ? ['/c', 'start', '""', filePath] :
    [filePath];
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    } catch (err) {
      reject(err);
      return;
    }
    proc.on('error', reject);
    // Don't wait for the spawned process; let it run independently.
    proc.unref();
    resolve();
  });
}

function buildReviewAnimations(inputs) {
  const animations = [];
  for (const inputPath of inputs) {
    const text = fs.readFileSync(inputPath, 'utf8');
    const inputBase = path.basename(inputPath, path.extname(inputPath));
    if (detectMode(text) === 'bundle') {
      let frames;
      try {
        frames = parseBundleFrames(text, inputPath);
      } catch (err) {
        console.warn(`warning: skipping ${relativeToHere(inputPath)}: ${err.message}`);
        continue;
      }
      for (const frame of frames) {
        animations.push({
          id: frame.id,
          title: frame.title,
          source: `${inputBase}/${frame.id}`,
          html: frame.html,
        });
      }
    } else {
      animations.push({
        id: inputBase,
        title: null,
        source: inputBase,
        html: text,
      });
    }
  }
  return animations;
}

async function runReview(paths, opts) {
  const cwd = process.cwd();
  const inputs = discoverInputs(paths, cwd);

  if (inputs.length === 0) {
    console.error('error: no .html files matched. Pass paths or run from a directory containing animations.');
    process.exit(1);
  }

  const animations = buildReviewAnimations(inputs);
  if (animations.length === 0) {
    console.error('error: no animations to review.');
    process.exit(1);
  }

  const html = buildReviewHtml(animations);

  const isTempFile = !opts.outOverride;
  const outPath = isTempFile
    ? path.join(os.tmpdir(), `h2v-review-${Date.now()}.html`)
    : path.resolve(cwd, opts.outOverride);

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html);
  } catch (err) {
    console.error(`error: could not write review file: ${err.message}`);
    process.exit(1);
  }

  console.log(
    `Review page (${animations.length} animation${animations.length === 1 ? '' : 's'}): ${outPath}`
  );

  if (!opts.skipOpen) {
    try {
      await openInBrowser(outPath);
    } catch (err) {
      console.warn(`warning: could not auto-open browser: ${err.message}`);
      console.warn(`open this file manually: ${outPath}`);
    }
  }

  // Decide whether to wait + clean up. We only auto-clean tmpfiles, and
  // only when the browser was actually opened (otherwise the user
  // probably wants the path to do something with).
  const willCleanup = isTempFile && !opts.keep && !opts.skipOpen;

  if (willCleanup) {
    console.log('Press Ctrl-C to close (and delete the temp file).');

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        fs.unlinkSync(outPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.warn(`\nwarning: could not delete ${outPath}: ${err.message}`);
          console.warn('you may need to delete it manually.');
        }
      }
    };

    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    process.on('exit', cleanup);

    // Keep the process alive until SIGINT/SIGTERM.
    await new Promise(() => {});
  }
}

// =========================================================================
// Main
// =========================================================================

async function main() {
  const { paths, opts } = parseArgs(process.argv);

  if (opts.command === 'review') {
    return runReview(paths, opts);
  }

  const cwd = process.cwd();
  const inputs = discoverInputs(paths, cwd);

  if (inputs.length === 0) {
    console.error('error: no .html files matched. Pass paths or run from a directory containing animations.');
    process.exit(1);
  }

  let jobs;
  try {
    jobs = buildPlan(inputs, opts);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
  validatePlan(jobs, opts);

  printPlan(jobs, opts);

  if (opts.dryRun) return;

  if (!opts.skipFfmpeg) ensureFfmpeg();

  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (err) {
    console.error('error: puppeteer is not installed. Run `npm install` first.');
    process.exit(1);
  }

  const capturesRoot = path.resolve(cwd, 'captures');
  fs.mkdirSync(capturesRoot, { recursive: true });
  fs.mkdirSync(path.resolve(cwd, opts.outDir), { recursive: true });

  console.log(
    `\nRecording at ${opts.width * opts.scale}×${opts.height * opts.scale} ` +
    `(${opts.width}×${opts.height} × ${opts.scale}), ${opts.fps}fps, crf ${opts.crf}, ` +
    `slowdown ${opts.slowdown}× (wall time = animation × ${opts.slowdown}).`
  );

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });

    try {
      for (const job of jobs) {
        const startedAt = Date.now();
        console.log(`\n${job.label} ${job.durationSeconds}s × ${opts.fps}fps = ${job.totalFrames} frames`);
        const captureDir = await recordJob(browser, job, opts, capturesRoot);
        if (!opts.skipFfmpeg) {
          const outPath = outputPathFor(job, opts);
          console.log(`    encoding → ${relativeToHere(outPath)}`);
          await ffmpegStitch(captureDir, outPath, opts);
        }
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`    done in ${elapsed}s`);
      }
    } finally {
      // Same rationale as recordJob's page.close: cleanup errors must not
      // mask success/failure of the actual recording.
      try { await browser.close(); } catch { /* ignore */ }
    }

    console.log('\nAll animations recorded.');
  } finally {
    if (!opts.skipFfmpeg) {
      try {
        fs.rmSync(capturesRoot, { recursive: true, force: true });
      } catch (err) {
        console.warn('Could not remove captures dir:', err.message);
      }
    }
  }
}

main().catch((err) => {
  console.error('\nERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
