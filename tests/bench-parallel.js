#!/usr/bin/env node
// Benchmark: do screenshots serialize across tabs in one browser?
//
// Loads sync-test.html in K parallel pages at 4K and takes 30 back-to-back
// screenshots in each (no tick-wait — worst case, all tabs hammering the
// screenshot pipeline at once). Compares total wall time across K=1, 2, 4.
//
// If screenshots are fully parallel, total time ≈ K=1 time.
// If they serialize, total time ≈ K × K=1 time.
// Reality is usually in between; this measures where.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const FIXTURE = path.resolve(__dirname, 'sync-test.html');
const FRAME_COUNT = 30;

async function recordPage(browser, jobIndex, dir) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 3 });
    await page.goto('file://' + FIXTURE, { waitUntil: 'load' });
    // Warm-up shot — first capture is always slower.
    await page.screenshot({ path: path.join(dir, `${jobIndex}-warmup.jpg`), type: 'jpeg', quality: 95 });
    const times = [];
    const start = process.hrtime.bigint();
    for (let i = 0; i < FRAME_COUNT; i++) {
      const t0 = process.hrtime.bigint();
      await page.screenshot({
        path: path.join(dir, `${jobIndex}-${i}.jpg`),
        type: 'jpeg',
        quality: 95,
      });
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const total = Number(process.hrtime.bigint() - start) / 1e6;
    return { total, times };
  } finally {
    await page.close();
  }
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
}

// Mode A: K pages in one browser.
async function runOneBrowser(K, dir) {
  const browser = await launchBrowser();
  try {
    const start = process.hrtime.bigint();
    const jobs = Array.from({ length: K }, (_, i) => recordPage(browser, i, dir));
    const results = await Promise.all(jobs);
    const wall = Number(process.hrtime.bigint() - start) / 1e6;
    const meanTotal = results.reduce((a, r) => a + r.total, 0) / K;
    const meanShot = results.reduce((a, r) => a + r.times.reduce((x, y) => x + y, 0) / r.times.length, 0) / K;
    return { wall, meanTotal, meanShot };
  } finally {
    await browser.close();
  }
}

// Mode B: K browsers, one page each.
async function runManyBrowsers(K, dir) {
  const start = process.hrtime.bigint();
  const browsers = await Promise.all(Array.from({ length: K }, () => launchBrowser()));
  try {
    const jobs = browsers.map((b, i) => recordPage(b, i, dir));
    const results = await Promise.all(jobs);
    const wall = Number(process.hrtime.bigint() - start) / 1e6;
    const meanTotal = results.reduce((a, r) => a + r.total, 0) / K;
    const meanShot = results.reduce((a, r) => a + r.times.reduce((x, y) => x + y, 0) / r.times.length, 0) / K;
    return { wall, meanTotal, meanShot };
  } finally {
    await Promise.all(browsers.map((b) => b.close().catch(() => {})));
  }
}

async function main() {
  console.log(`viewport: 1280x720 @ 3x = 3840x2160 (4K)`);
  console.log(`each tab: ${FRAME_COUNT} back-to-back screenshots (no tick wait)`);
  console.log('');

  const Ks = [1, 2, 4];
  const mode = process.argv[2] || 'both';

  if (mode === 'A' || mode === 'both') {
    console.log('=== Mode A: K pages, one browser ===');
    console.log('K   wall    mean per-tab loop   mean per-shot   ratio vs K=1');
    console.log('--  ------  ------------------  --------------  ------------');
    let baselineA = null;
    for (const K of Ks) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-A-${K}-`));
      const { wall, meanTotal, meanShot } = await runOneBrowser(K, dir);
      if (baselineA === null) baselineA = wall;
      const ratio = K === 1 ? '1.00×' : `${(baselineA * K / wall).toFixed(2)}× of ideal`;
      console.log(
        `${String(K).padEnd(2)}  ${(wall/1000).toFixed(2).padStart(5)}s  ${(meanTotal/1000).toFixed(2).padStart(5)}s              ${String(meanShot.toFixed(0)).padStart(4)}ms        ${ratio}`
      );
      fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('');
  }

  if (mode === 'B' || mode === 'both') {
    console.log('=== Mode B: K browsers, one page each ===');
    console.log('K   wall    mean per-tab loop   mean per-shot   ratio vs K=1');
    console.log('--  ------  ------------------  --------------  ------------');
    let baselineB = null;
    for (const K of Ks) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-B-${K}-`));
      const { wall, meanTotal, meanShot } = await runManyBrowsers(K, dir);
      if (baselineB === null) baselineB = wall;
      const ratio = K === 1 ? '1.00×' : `${(baselineB * K / wall).toFixed(2)}× of ideal`;
      console.log(
        `${String(K).padEnd(2)}  ${(wall/1000).toFixed(2).padStart(5)}s  ${(meanTotal/1000).toFixed(2).padStart(5)}s              ${String(meanShot.toFixed(0)).padStart(4)}ms        ${ratio}`
      );
      fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('');
  }
  console.log('"× of ideal" = how close to perfect linear scaling.');
  console.log('  1.00× = serialized (no win). K× = perfect parallelism.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
