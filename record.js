#!/usr/bin/env node
'use strict';

// Records each frame in ./frames/ to a 4K MP4 in ./output/ at 60fps.
//
// Reads the frame manifest (filenames + capture durations) from FRAME_START
// markers in all-frames-bundle.html. Opens each frame in headless Chrome with a
// virtual clock installed before any page script runs, so animations advance
// only when the recorder ticks them — eliminating timing drift caused by
// variable screenshot encoding latency.
//
// Prerequisites: `npm install puppeteer` and `ffmpeg` on PATH.
//
// Usage:
//   node record.js                    # record all frames, dark theme
//   node record.js frame-01 frame-05  # record a subset
//   node record.js --light            # record in light theme
//   node record.js --no-ffmpeg        # capture PNGs only, skip stitching

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const PROJECT_ROOT = __dirname;
const BUNDLE_PATH = path.join(PROJECT_ROOT, 'all-frames-bundle.html');
const FRAMES_DIR = path.join(PROJECT_ROOT, 'frames');
const CAPTURES_DIR = path.join(PROJECT_ROOT, 'captures');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');

const FPS = 60;
const TICK_MS = 1000 / FPS; // 16.6667ms per frame
const VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 3 };

function parseManifest() {
  const text = fs.readFileSync(BUNDLE_PATH, 'utf8');
  const re = /<!--\s*=+\s*FRAME_START\s+id="([^"]+)"\s+title="([^"]+)"\s+filename="([^"]+)"\s+capture_duration="(\d+)s"\s*=+\s*-->/g;
  const frames = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, id, title, filename, sec] = m;
    const seconds = parseInt(sec, 10);
    frames.push({ id, title, filename, seconds, totalFrames: seconds * FPS });
  }
  if (frames.length === 0) {
    throw new Error('No FRAME_START markers found in ' + BUNDLE_PATH);
  }
  return frames;
}

// Runs in the page context BEFORE any inline script executes. Replaces Date,
// performance.now, setTimeout, setInterval, and requestAnimationFrame with a
// virtual clock that only advances when window.__advanceClock(ms) is called
// from outside. Pending timers fire in fireAt order; pending rAFs fire once
// per advance, snapshotted before execution so callbacks queueing more rAFs
// don't loop within a single tick.
//
// Note: this controls JS-driven timing. CSS animations and transitions are
// still composited against real time by Chromium; for fully frame-perfect CSS
// you would also need CDP's Emulation.setVirtualTimePolicy.
function installClockOverride() {
  const RealDate = window.Date;
  const realPerformance = window.performance;
  const baseEpoch = RealDate.now();
  let virtualNow = 0;
  let nextId = 1;
  const tasks = new Map();

  function FakeDate(...args) {
    if (!(this instanceof FakeDate)) {
      return new RealDate(baseEpoch + virtualNow).toString();
    }
    if (args.length === 0) return new RealDate(baseEpoch + virtualNow);
    return new RealDate(...args);
  }
  FakeDate.now = () => Math.floor(baseEpoch + virtualNow);
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  FakeDate.prototype = RealDate.prototype;
  window.Date = FakeDate;

  realPerformance.now = () => virtualNow;

  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    tasks.set(id, { kind: 'raf', fn: cb });
    return id;
  };
  window.cancelAnimationFrame = (id) => { tasks.delete(id); };

  window.setTimeout = (fn, delay, ...args) => {
    const id = nextId++;
    const d = typeof delay === 'number' ? Math.max(0, delay) : 0;
    tasks.set(id, { kind: 'timeout', fn, args, fireAt: virtualNow + d });
    return id;
  };
  window.clearTimeout = (id) => { tasks.delete(id); };

  window.setInterval = (fn, delay, ...args) => {
    const id = nextId++;
    const d = typeof delay === 'number' ? Math.max(1, delay) : 1;
    tasks.set(id, { kind: 'interval', fn, args, fireAt: virtualNow + d, period: d });
    return id;
  };
  window.clearInterval = (id) => { tasks.delete(id); };

  window.__advanceClock = (ms) => {
    const target = virtualNow + ms;
    let safety = 0;
    while (safety++ < 100000) {
      let bestId = null;
      let bestFireAt = Infinity;
      for (const [id, t] of tasks) {
        if (t.kind === 'raf') continue;
        if (t.fireAt <= target && t.fireAt < bestFireAt) {
          bestId = id;
          bestFireAt = t.fireAt;
        }
      }
      if (bestId === null) break;
      const t = tasks.get(bestId);
      virtualNow = t.fireAt;
      if (t.kind === 'interval') {
        t.fireAt = virtualNow + t.period;
      } else {
        tasks.delete(bestId);
      }
      try { t.fn.apply(null, t.args || []); }
      catch (e) { console.error('[virtual-timer]', e); }
    }
    if (safety >= 100000) {
      console.warn('[virtual-clock] gave up after 100000 timer iterations in one tick');
    }
    virtualNow = target;

    const rafIds = [];
    for (const [id, t] of tasks) if (t.kind === 'raf') rafIds.push(id);
    for (const id of rafIds) {
      const t = tasks.get(id);
      if (!t) continue;
      tasks.delete(id);
      try { t.fn(virtualNow); }
      catch (e) { console.error('[virtual-raf]', e); }
    }
  };
}

async function recordFrame(browser, frame, opts) {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  await page.evaluateOnNewDocument(installClockOverride);

  const url = 'file://' + path.join(FRAMES_DIR, frame.filename);
  await page.goto(url, { waitUntil: 'load' });

  const ready = await page.evaluate(() => typeof window.__advanceClock === 'function');
  if (!ready) throw new Error('Clock override missing on ' + frame.id);

  if (opts.theme === 'light') {
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  }

  const captureDir = path.join(
    CAPTURES_DIR,
    frame.id + (opts.theme === 'light' ? '-light' : '')
  );
  fs.rmSync(captureDir, { recursive: true, force: true });
  fs.mkdirSync(captureDir, { recursive: true });

  for (let i = 1; i <= frame.totalFrames; i++) {
    await page.evaluate((tick) => window.__advanceClock(tick), TICK_MS);
    const fileName = String(i).padStart(4, '0') + '.png';
    await page.screenshot({ path: path.join(captureDir, fileName), type: 'png' });
    if (i % FPS === 0 || i === frame.totalFrames) {
      process.stdout.write(`\r    captured ${i}/${frame.totalFrames}`);
    }
  }
  process.stdout.write('\n');
  await page.close();
  return captureDir;
}

function ffmpegStitch(captureDir, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-loglevel', 'error',
      '-framerate', String(FPS),
      '-start_number', '1',
      '-i', path.join(captureDir, '%04d.png'),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '18',
      outPath,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    proc.on('error', reject);
    proc.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('ffmpeg exited with code ' + code))
    );
  });
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const onlyIds = [];
  const opts = { theme: 'dark', skipFfmpeg: false };
  for (const a of args) {
    if (a === '--light') opts.theme = 'light';
    else if (a === '--no-ffmpeg') opts.skipFfmpeg = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node record.js [frame-NN ...] [--light] [--no-ffmpeg]');
      process.exit(0);
    } else if (/^frame-\d+$/.test(a)) {
      onlyIds.push(a);
    } else {
      console.error('Unknown arg:', a);
      process.exit(1);
    }
  }
  return { onlyIds, opts };
}

async function main() {
  const { onlyIds, opts } = parseArgs(process.argv);
  const allFrames = parseManifest();
  const frames = onlyIds.length === 0
    ? allFrames
    : allFrames.filter((f) => onlyIds.includes(f.id));
  if (frames.length === 0) {
    console.error('No frames matched:', onlyIds.join(', '));
    process.exit(1);
  }

  fs.mkdirSync(CAPTURES_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const outRes = `${VIEWPORT.width * VIEWPORT.deviceScaleFactor}×${VIEWPORT.height * VIEWPORT.deviceScaleFactor}`;
  console.log(
    `Recording ${frames.length} frame(s) at ${outRes}, ${FPS}fps, theme=${opts.theme}` +
    (opts.skipFfmpeg ? ' (PNG only)' : '')
  );

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });

    try {
      for (const frame of frames) {
        const startedAt = Date.now();
        console.log(
          `\n[${frame.id}] ${frame.title} — ${frame.seconds}s × ${FPS}fps = ${frame.totalFrames} frames`
        );
        const captureDir = await recordFrame(browser, frame, opts);
        if (!opts.skipFfmpeg) {
          const suffix = opts.theme === 'light' ? '-light' : '';
          const outPath = path.join(OUTPUT_DIR, `${frame.id}${suffix}.mp4`);
          console.log(`    encoding → ${path.basename(outPath)}`);
          await ffmpegStitch(captureDir, outPath);
        }
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`    done in ${elapsed}s`);
      }
    } finally {
      await browser.close();
    }

    console.log('\nAll frames recorded.');
  } finally {
    // Clean up intermediate PNGs on both success and failure. Skipped when
    // --no-ffmpeg is set, since in that mode the PNGs are the deliverable.
    if (!opts.skipFfmpeg) {
      try {
        fs.rmSync(CAPTURES_DIR, { recursive: true, force: true });
      } catch (err) {
        console.warn('Could not remove captures dir:', err.message);
      }
    }
  }
}

main().catch((e) => {
  console.error('\nERROR:', e);
  process.exit(1);
});
