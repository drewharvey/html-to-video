#!/usr/bin/env node
'use strict';

// End-to-end test for the `h2v review` scrub bar (play / pause / scrub for
// seek-aware animations). Builds a portable review page (--out) from two
// fixtures written to a tmp dir, loads it in headless Chrome, and drives the
// real UI:
//   - seek.html — exposes window.seek; records the last ms it was seeked to
//     and a step counter that resets on a backward seek (an order-dependent
//     engine, to check the release-time warm-up replay).
//   - plain.html — no window.seek, so it must get no scrub bar.
//
// Also covers the centre play/pause "flash" (shown for clicks on the preview
// and Space, not for the transport button) and Space-to-toggle.
//
// The shared scenario harness is synchronous and can't drive a browser, so
// this file does its own async orchestration (same pattern as
// test-review-serve.js). Needs Puppeteer's Chrome (PUPPETEER_EXECUTABLE_PATH
// is honoured). Run via `npm run test:review-scrub` (part of test:e2e).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer');

const CLI = path.join(__dirname, '..', 'cli.js');
const DURATION_MS = 3000;
const FRAME_MS = 1000 / 60;

let failures = 0;
function ok(cond, msg, detail) {
  if (cond) {
    console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
  } else {
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m ${msg}${detail !== undefined ? `\n      got: ${JSON.stringify(detail)}` : ''}`);
  }
}

const SEEK_FIXTURE = `<!DOCTYPE html>
<html><head>
<meta name="h2v-duration" content="${DURATION_MS / 1000}s">
<meta name="h2v-viewport" content="320x180">
<style>html,body{margin:0;height:100%;background:#222}</style>
</head><body>
<button id="own" style="position:absolute;left:4px;top:4px">own control</button>
<script>
  var steps = 0, last = -1;
  window.seek = function (ms) {
    if (ms < last) steps = 0;
    if (ms > last) steps++;
    last = ms;
    window.lastMs = ms;
    window.steps = steps;
  };
  window.seek(0);
  window.sawScrub = window.__SCRUB__ === true;
</script>
</body></html>`;

const PLAIN_FIXTURE = `<!DOCTYPE html>
<html><head><meta name="h2v-duration" content="1s"><meta name="h2v-viewport" content="320x180"></head>
<body>plain</body></html>`;

(async () => {
  console.log('test-review-scrub.js — h2v review scrub bar (browser)');
  console.log('');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2v-scrub-'));
  let browser;
  try {
    fs.writeFileSync(path.join(dir, 'seek.html'), SEEK_FIXTURE);
    fs.writeFileSync(path.join(dir, 'plain.html'), PLAIN_FIXTURE);
    const out = path.join(dir, 'review.html');
    const r = spawnSync('node', [CLI, 'review', 'seek.html', 'plain.html', '--no-open', '--out', out],
      { cwd: dir, encoding: 'utf8' });
    ok(r.status === 0, 'h2v review --out builds the page', r.stderr);
    if (r.status !== 0) return;

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.setViewport({ width: 1200, height: 900 });
    await page.goto(pathToFileURL(out).href);

    // Cards are in ANIMATIONS order; find each by its title rather than index.
    const cardSel = (name) => `[id^="anim-"]:has(iframe[title="${name}"])`;
    const SEEK = cardSel('Seek');
    const PLAIN = cardSel('Plain');

    // Snapshot of the seek card's bar + the animation's own window state.
    const state = () => page.evaluate((sel) => {
      const card = document.querySelector(sel);
      const range = card.querySelector('.scrub-range');
      const w = card.querySelector('iframe').contentWindow;
      return {
        hidden: card.querySelector('.scrub').hidden,
        btn: card.querySelector('.scrub-btn').title,
        value: Number(range.value),
        max: Number(range.max),
        lastMs: w.lastMs,
        steps: w.steps,
        sawScrub: w.sawScrub,
      };
    }, SEEK);
    const btnIs = (title, timeout = 5000) => page.waitForFunction(
      (sel, t) => document.querySelector(sel + ' .scrub-btn').title === t,
      { timeout }, SEEK, title,
    ).then(() => true, () => false);
    const key = async (k, mods = []) => {
      for (const m of mods) await page.keyboard.down(m);
      await page.keyboard.press(k);
      for (const m of mods.slice().reverse()) await page.keyboard.up(m);
    };

    // Wait for the seek card's bar to be armed (iframe load + detection).
    await page.waitForFunction((sel) => !document.querySelector(sel + ' .scrub').hidden,
      { timeout: 10000 }, SEEK).catch(() => {});

    // --- Detection + __SCRUB__ -------------------------------------------
    let s = await state();
    ok(!s.hidden, 'seek-aware animation shows the scrub bar');
    ok(s.sawScrub === true, 'window.__SCRUB__ is set before the page script runs', s.sawScrub);
    ok(s.max === DURATION_MS, 'slider spans the h2v-duration meta', s.max);
    const plainHidden = await page.evaluate((sel) => document.querySelector(sel + ' .scrub').hidden, PLAIN);
    ok(plainHidden === true, 'animation without window.seek gets no scrub bar');

    // --- Autoplay runs to the very end ------------------------------------
    ok(await btnIs('Pause', 2000), 'autoplays on load');
    const ended = await btnIs('Play', DURATION_MS + 3000);
    s = await state();
    ok(ended, 'stops when playback reaches the end');
    ok(s.value === s.max && s.lastMs === DURATION_MS,
      'slider and animation both sit at the final frame (not one frame short)', s);

    // --- Click to toggle --------------------------------------------------
    // Inside the animation, away from its own button (top-left).
    const box = await (await page.$(SEEK + ' iframe')).boundingBox();
    await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.75);
    ok(await btnIs('Pause', 1000), 'clicking the animation plays it');
    await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.75);
    ok(await btnIs('Play', 1000), 'clicking it again pauses it');
    const ownBox = await page.evaluate((sel) => {
      const ifr = document.querySelector(sel + ' iframe');
      const r = ifr.getBoundingClientRect();
      const b = ifr.contentDocument.getElementById('own').getBoundingClientRect();
      const k = r.width / ifr.offsetWidth; // the stage scales the iframe
      return { x: r.left + (b.left + b.width / 2) * k, y: r.top + (b.top + b.height / 2) * k };
    }, SEEK);
    await page.mouse.click(ownBox.x, ownBox.y);
    await new Promise((res) => setTimeout(res, 200));
    ok((await state()).btn === 'Play', "clicks on the animation's own controls don't toggle playback");
    // The stage area around the iframe (letterbox in full screen).
    await page.evaluate((sel) => document.querySelector(sel + ' .frame-stage')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })), SEEK);
    ok(await btnIs('Pause', 1000), 'clicking the stage around the animation toggles too');
    await page.click(SEEK + ' .scrub-btn');
    ok(await btnIs('Play', 1000), 'play/pause button pauses');

    // --- Centre play/pause flash + Space -----------------------------------
    // flash() swaps the icon and restarts the CSS animation; record each
    // call's resulting state so the test needn't race the 700 ms fade.
    await page.evaluate((sel) => {
      const f = document.querySelector(sel + ' .toggle-flash');
      window.__flashes = [];
      new MutationObserver(() => {
        if (f.classList.contains('show')) window.__flashes.push(f.classList.contains('is-play') ? 'play' : 'pause');
      }).observe(f, { attributes: true, attributeFilter: ['class'] });
    }, SEEK);
    const flashes = () => page.evaluate(() => window.__flashes.splice(0));
    await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.75); // play
    await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.75); // pause
    let f = await flashes();
    ok(f.join() === 'play,pause', 'clicking the preview flashes the state entered (play, then pause)', f);
    await page.click(SEEK + ' .scrub-btn');
    await page.click(SEEK + ' .scrub-btn');
    f = await flashes();
    ok(f.length === 0, "the transport button doesn't flash", f);
    ok((await state()).btn === 'Play', 'transport button toggled twice → paused');
    // The transport button now has focus. Space on it must toggle exactly
    // once (the native keyup click is swallowed) and, being Space, flash.
    await key('Space');
    await new Promise((res) => setTimeout(res, 150));
    f = await flashes();
    ok((await state()).btn === 'Pause' && f.join() === 'play',
      'Space on the focused transport button toggles once, with the flash', { btn: (await state()).btn, f });
    // Space with focus inside the animation's document.
    await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.75); // → paused
    await key('Space');
    ok(await btnIs('Pause', 1000), 'Space inside the animation toggles it');
    await key('Space');
    ok(await btnIs('Play', 1000), 'Space again pauses');
    f = await flashes();
    ok(f.join() === 'pause,play,pause', 'Space flashes like a click', f);
    // Space with nothing focused targets the card being read, and doesn't
    // scroll the page.
    await page.evaluate(() => { document.activeElement && document.activeElement.blur(); window.focus(); });
    const y0 = await page.evaluate(() => window.scrollY);
    await key('Space');
    ok(await btnIs('Pause', 1000), 'Space with nothing focused toggles the current card');
    ok((await page.evaluate(() => window.scrollY)) === y0, "Space doesn't scroll the page");
    await key('Space');
    ok(await btnIs('Play', 1000), 'and pauses it again');
    // Space on the animation's own button stays with that button.
    await page.evaluate((sel) => document.querySelector(sel + ' iframe').contentDocument.getElementById('own').focus(), SEEK);
    await key('Space');
    await new Promise((res) => setTimeout(res, 200));
    ok((await state()).btn === 'Play', "Space on the animation's own control doesn't toggle playback");
    await flashes();

    // --- Keyboard frame stepping ------------------------------------------
    await page.focus(SEEK + ' .scrub-range');
    await key('Home');
    s = await state();
    ok(s.value === 0 && s.lastMs === 0, 'Home jumps to the start', s);
    await key('ArrowRight');
    await key('ArrowRight');
    s = await state();
    ok(Math.abs(s.value - 2 * FRAME_MS) < 1e-6 && Math.abs(s.lastMs - 2 * FRAME_MS) < 1e-6,
      'ArrowRight steps exactly one frame', s);
    await key('ArrowLeft');
    s = await state();
    ok(Math.abs(s.value - FRAME_MS) < 1e-6, 'ArrowLeft steps back one frame', s);
    await key('ArrowRight', ['Shift']);
    s = await state();
    ok(Math.abs(s.value - (FRAME_MS + 1000)) < 1e-6, 'Shift+ArrowRight steps one second', s);
    await key('End');
    s = await state();
    ok(s.value === DURATION_MS && s.lastMs === DURATION_MS, 'End jumps to the final frame', s);

    // --- Release replays seek() from 0 (order-dependent engines) ----------
    // A cold jump to 500 ms leaves the step counter tiny; releasing must
    // replay frames 0..29 then seek(500) → 30 forward steps, i.e. the frame
    // is reached sequentially, the way export reaches it.
    const steps = await page.evaluate((sel) => {
      const range = document.querySelector(sel + ' .scrub-range');
      range.value = 500;
      range.dispatchEvent(new Event('input'));
      const w = document.querySelector(sel + ' iframe').contentWindow;
      const cold = w.steps;
      range.dispatchEvent(new Event('change'));
      return { cold, settled: w.steps, lastMs: w.lastMs };
    }, SEEK);
    ok(steps.cold < 5 && steps.settled === 30 && steps.lastMs === 500,
      'releasing the slider replays seek() frame-by-frame from 0', steps);

    // --- Drag pauses, release resumes -------------------------------------
    await page.click(SEEK + ' .scrub-btn'); // play from 500 ms
    ok(await btnIs('Pause', 1000), 'resumes playing from the scrubbed position');
    const rb = await (await page.$(SEEK + ' .scrub-range')).boundingBox();
    await page.mouse.move(rb.x + rb.width * 0.2, rb.y + rb.height / 2);
    await page.mouse.down();
    ok(await btnIs('Play', 1000), 'pressing on the slider pauses playback');
    await page.mouse.move(rb.x + rb.width * 0.3, rb.y + rb.height / 2, { steps: 4 });
    await page.mouse.up();
    ok(await btnIs('Pause', 1000), 'releasing the slider resumes playback');
    await page.click(SEEK + ' .scrub-btn');
    ok(await btnIs('Play', 1000), 'paused again before reload');

    // --- Paused position survives a reload; Reset all clears it -----------
    await page.focus(SEEK + ' .scrub-range');
    await key('Home');
    for (let i = 0; i < 3; i++) await key('ArrowRight');
    await page.reload();
    await page.waitForFunction((sel) => !document.querySelector(sel + ' .scrub').hidden,
      { timeout: 10000 }, SEEK).catch(() => {});
    await new Promise((res) => setTimeout(res, 300));
    s = await state();
    ok(s.btn === 'Play' && Math.abs(s.value - 3 * FRAME_MS) < 1e-6 && Math.abs(s.lastMs - 3 * FRAME_MS) < 1e-6,
      'a reload restores the paused frame instead of replaying', s);
    await page.click('#resetAll');
    ok(await btnIs('Pause', 3000), 'Reset all clears the saved position and replays from the start');

    ok(pageErrors.length === 0, 'no page errors', pageErrors);
  } catch (err) {
    ok(false, `unexpected error: ${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('');
  if (failures) {
    console.log(`\x1b[31m${failures} check(s) failed.\x1b[0m`);
    process.exit(1);
  }
  console.log('\x1b[32mall checks passed.\x1b[0m');
})();
