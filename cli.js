#!/usr/bin/env node
'use strict';

const fs = require('fs');
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
  outDir: 'output',
};

const SKIP_FILENAMES = new Set(['review.html']);

const FRAME_BLOCK_RE =
  /<!--\s*=+\s*FRAME_START\s+(.*?)\s*=+\s*-->\s*([\s\S]*?)\s*<!--\s*=+\s*FRAME_END\b[^>]*?-->/g;
const FRAME_START_PROBE = /<!--\s*=+\s*FRAME_START\b/;
const META_DURATION_RE =
  /<meta\s+name=["']h2v-duration["']\s+content=["']?(\d+(?:\.\d+)?)\s*s?["']?\s*\/?>/i;
const ATTR_RE = /(\w+)="([^"]*)"/g;

// =========================================================================
// Help & version
// =========================================================================

const HELP_TEXT = `h2v v${VERSION} — record HTML animations as 4K MP4s

USAGE
  h2v export [<paths...>] [flags]
  h2v --help
  h2v --version

ARGUMENTS
  paths     One or more HTML files or directories. With no paths, every
            *.html in the current directory is processed (non-recursive).
            Files inside an explicitly named directory are filtered with
            the same rules: dotfiles and review.html are skipped.

FLAGS
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
  --theme <m>         dark | light | both (default: dark). 'both' produces
                      two MP4s per animation; light has a -light suffix.
  --out-dir <path>    Output directory (default: ./${DEFAULTS.outDir}).
  --out <path>        Exact output filename. Only valid when exactly one
                      MP4 will be produced.
  --no-ffmpeg         Capture PNGs only; skip stitching and the captures
                      cleanup step.
  --dry-run           Print the recording plan and exit (no browser needed).
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
  if (command !== 'export') {
    console.error(`error: unknown command: ${command}`);
    console.error(`Did you mean: h2v export ${args.join(' ')} ?`);
    process.exit(2);
  }

  const positional = [];
  const opts = {
    duration: DEFAULTS.duration,
    fps: DEFAULTS.fps,
    width: DEFAULTS.width,
    height: DEFAULTS.height,
    scale: DEFAULTS.scale,
    crf: DEFAULTS.crf,
    themes: ['dark'],
    outDir: DEFAULTS.outDir,
    outOverride: null,
    skipFfmpeg: false,
    dryRun: false,
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
    else if (a === '--theme') opts.themes = parseThemeFlag(requireValue('--theme'));
    else if (a === '--out-dir') opts.outDir = requireValue('--out-dir');
    else if (a === '--out') opts.outOverride = requireValue('--out');
    else if (a === '--no-ffmpeg') opts.skipFfmpeg = true;
    else if (a === '--dry-run') opts.dryRun = true;
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
  return FRAME_START_PROBE.test(htmlText) ? 'bundle' : 'single';
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
  FRAME_BLOCK_RE.lastIndex = 0;
  while ((m = FRAME_BLOCK_RE.exec(htmlText)) !== null) {
    const attrs = parseAttributes(m[1]);
    if (!attrs.id) {
      throw new Error(`${sourcePath}: FRAME_START without id attribute`);
    }
    if (!attrs.capture_duration) {
      throw new Error(`${sourcePath}: FRAME_START id="${attrs.id}" missing capture_duration`);
    }
    const durMatch = attrs.capture_duration.match(/^(\d+(?:\.\d+)?)s?$/i);
    if (!durMatch) {
      throw new Error(`${sourcePath}: FRAME_START id="${attrs.id}" has invalid capture_duration "${attrs.capture_duration}"`);
    }
    frames.push({
      id: attrs.id,
      title: attrs.title || attrs.id,
      durationSeconds: parseFloat(durMatch[1]),
      html: m[2],
    });
  }
  if (frames.length === 0) {
    throw new Error(`${sourcePath}: bundle marker found but no complete FRAME_START/FRAME_END pair`);
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
// Virtual time + Web Animations API per-frame control
// =========================================================================
//
// We virtualize timing in two layers:
//
//   1. Emulation.setVirtualTimePolicy (CDP) — virtualizes the JS *timer*
//      clock. Date.now, performance.now, setTimeout, setInterval, and
//      requestAnimationFrame only advance when we hand out a budget.
//
//   2. document.getAnimations() in the page — every CSS transition,
//      CSS keyframe animation, and Web Animations API animation is
//      reachable through this list. After each virtual-time tick we
//      pause every running animation and set its `currentTime` to the
//      elapsed virtual time since its `startTime`. This sidesteps the
//      compositor's own clock entirely, which is necessary because
//      HeadlessExperimental.beginFrame (the "proper" way to drive the
//      compositor) is not supported on macOS.
//
// SMIL animations (<animate> in SVG) are NOT covered by this — they
// don't appear in document.getAnimations(). The Swing example uses
// CSS transitions throughout, which are covered.

const VIRTUAL_TIME_OPTS = {
  // Pause again after running this many tasks in a row, even if budget
  // hasn't expired. Prevents tight `setInterval` loops from starving
  // the budget timer.
  maxVirtualTimeTaskStarvationCount: 100,
};
const NAV_BUDGET_MS = 30000;

function advanceVirtualTime(client, ms) {
  return new Promise((resolve) => {
    client.once('Emulation.virtualTimeBudgetExpired', resolve);
    client.send('Emulation.setVirtualTimePolicy', {
      policy: 'pauseIfNetworkFetchesPending',
      budget: ms,
      ...VIRTUAL_TIME_OPTS,
    });
  });
}

// Snap every Animation in the page to a specific virtual time. Run after
// every virtual-time advance and before every screenshot.
async function syncAnimationsTo(page, virtualNowMs) {
  await page.evaluate((virtualNow) => {
    for (const anim of document.getAnimations()) {
      // Pause anything that's still running on the compositor's wall clock.
      if (anim.playState === 'running') {
        try { anim.pause(); } catch (_) { /* finished/cancelled */ }
      }
      // Set currentTime to the elapsed virtual time since the animation
      // started. anim.startTime is in document.timeline coordinates,
      // which setVirtualTimePolicy virtualizes.
      if (anim.startTime != null) {
        const elapsed = virtualNow - anim.startTime;
        if (elapsed >= 0) {
          try { anim.currentTime = elapsed; } catch (_) { /* finished */ }
        }
      }
    }
  }, virtualNowMs);
}

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

    const client = await page.target().createCDPSession();

    // Pause virtual time before navigation so timers and animations the
    // page schedules during load stay pending until we tick them.
    const initialVirtualTime = Date.now();
    await client.send('Emulation.setVirtualTimePolicy', {
      policy: 'pause',
      initialVirtualTime,
    });

    // Allow virtual time to flow during navigation/load, then re-pause.
    const navigation =
      job.mode === 'bundle'
        ? page.setContent(job.bundleHtml, { waitUntil: 'load' })
        : page.goto('file://' + job.inputPath, { waitUntil: 'load' });

    await client.send('Emulation.setVirtualTimePolicy', {
      policy: 'pauseIfNetworkFetchesPending',
      budget: NAV_BUDGET_MS,
      ...VIRTUAL_TIME_OPTS,
    });
    await navigation;
    await client.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });

    if (job.theme === 'light') {
      await page.evaluate(() =>
        document.documentElement.setAttribute('data-theme', 'light')
      );
    }

    const captureDir = path.join(capturesRoot, job.captureKey);
    fs.rmSync(captureDir, { recursive: true, force: true });
    fs.mkdirSync(captureDir, { recursive: true });

    // Pause whatever animations exist already (e.g. fade-ins triggered by
    // CSS rules with auto-playing keyframes).
    await syncAnimationsTo(page, await page.evaluate(() => Date.now()));

    const tickMs = 1000 / opts.fps;
    let absVirtualMs = await page.evaluate(() => Date.now());

    for (let i = 1; i <= job.totalFrames; i++) {
      absVirtualMs += tickMs;
      // Advance the JS timer clock; setTimeout/setInterval/rAF callbacks
      // for the next tickMs of virtual time fire here. New CSS transitions
      // may be created as a side effect.
      await advanceVirtualTime(client, tickMs);
      // Snap every Animation (existing and newly-created) to absolute
      // virtual time. This is what makes CSS transitions/animations
      // advance in lockstep with the JS clock.
      await syncAnimationsTo(page, absVirtualMs);
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
    // Cleanup errors must not mask a real recording error from the try
    // block. JS re-throws the original error after this silent catch.
    try { await page.close(); } catch { /* ignore */ }
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
// Main
// =========================================================================

async function main() {
  const { paths, opts } = parseArgs(process.argv);
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
    `(${opts.width}×${opts.height} × ${opts.scale}), ${opts.fps}fps, crf ${opts.crf}.`
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
