#!/usr/bin/env node
// Benchmark screenshot speed for the recorder's hot path.
//
// Loads tests/sync-test.html at 4K (1280x720 @ 3x deviceScaleFactor) and
// captures 30 frames per configuration. Reports mean, p50, p95 ms per
// screenshot. Output PNGs go to /tmp/bench-* and are deleted at the end.
//
// Configurations tested:
//   - PNG (current default)
//   - PNG + optimizeForSpeed
//   - PNG + captureBeyondViewport:false
//   - JPEG q=95
//   - JPEG q=85
//   - WebP q=95
//   - WebP lossless

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const FIXTURE = path.resolve(__dirname, 'sync-test.html');
const N = 30;

function pct(arr, p) {
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function fmt(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return `mean ${mean.toFixed(1)}ms  p50 ${pct(arr, 0.5).toFixed(0)}ms  p95 ${pct(arr, 0.95).toFixed(0)}ms`;
}

async function timeShots(page, dir, opts, n) {
  fs.mkdirSync(dir, { recursive: true });
  const times = [];
  let totalBytes = 0;
  for (let i = 0; i < n; i++) {
    const file = path.join(dir, `${String(i).padStart(3, '0')}.${opts._ext}`);
    const start = process.hrtime.bigint();
    await page.screenshot({ ...opts.shot, path: file });
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    times.push(elapsed);
    totalBytes += fs.statSync(file).size;
  }
  return {
    times,
    avgKb: (totalBytes / n / 1024).toFixed(0),
  };
}

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 3 });
    await page.goto('file://' + FIXTURE, { waitUntil: 'load' });

    const configs = [
      { name: 'PNG (baseline)', _ext: 'png', shot: { type: 'png' } },
      { name: 'PNG optimizeForSpeed', _ext: 'png', shot: { type: 'png', optimizeForSpeed: true } },
      { name: 'PNG no captureBeyondViewport', _ext: 'png', shot: { type: 'png', captureBeyondViewport: false } },
      { name: 'PNG optimize + no CBV', _ext: 'png', shot: { type: 'png', optimizeForSpeed: true, captureBeyondViewport: false } },
      { name: 'JPEG q=95', _ext: 'jpg', shot: { type: 'jpeg', quality: 95 } },
      { name: 'JPEG q=85', _ext: 'jpg', shot: { type: 'jpeg', quality: 85 } },
      { name: 'WebP q=95', _ext: 'webp', shot: { type: 'webp', quality: 95 } },
      { name: 'WebP q=100 (lossless-ish)', _ext: 'webp', shot: { type: 'webp', quality: 100 } },
    ];

    // Warm-up — first screenshot is always slow.
    await page.screenshot({ type: 'png', path: '/tmp/bench-warmup.png' });

    const benchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
    console.log(`viewport: 1280x720 @ 3x = 3840x2160 (4K)`);
    console.log(`samples per config: ${N}`);
    console.log(`fixture: ${FIXTURE}`);
    console.log('');

    for (const cfg of configs) {
      const dir = path.join(benchRoot, cfg.name.replace(/[^a-z0-9]+/gi, '-'));
      const { times, avgKb } = await timeShots(page, dir, cfg, N);
      console.log(`${cfg.name.padEnd(34)} ${fmt(times)}  avg ${avgKb}KB/frame`);
    }

    fs.rmSync(benchRoot, { recursive: true, force: true });
    try { fs.unlinkSync('/tmp/bench-warmup.png'); } catch {}
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
