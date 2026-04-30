#!/usr/bin/env node
// Capture the same frame in PNG and JPEG q=95 / q=85 for visual side-by-side
// comparison. Outputs go to /tmp/quality-* and survive the run so you can
// inspect them with the Read tool.

'use strict';

const path = require('path');
const puppeteer = require('puppeteer');

const FIXTURE = path.resolve(__dirname, '..', process.argv[2] || 'tests/sync-test.html');

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
    // Animation runs ~1.5s; wait for it to fully settle so all three
    // captures are of an identical stable frame.
    await new Promise((r) => setTimeout(r, 2500));

    const out = '/tmp/quality';
    await page.screenshot({ path: `${out}.png`, type: 'png' });
    await page.screenshot({ path: `${out}-q95.jpg`, type: 'jpeg', quality: 95 });
    await page.screenshot({ path: `${out}-q85.jpg`, type: 'jpeg', quality: 85 });

    console.log(`PNG     -> ${out}.png`);
    console.log(`JPEG q95 -> ${out}-q95.jpg`);
    console.log(`JPEG q85 -> ${out}-q85.jpg`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
