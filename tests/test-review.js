#!/usr/bin/env node
//
// Correctness tests for `h2v review --no-open`. Review's HTML generation
// is pure JS (no Chromium needed); we assert on the structure of the
// generated review page.
//
// Structure to know: review's HTML embeds a JS array literal:
//     const ANIMATIONS = [{id: "...", html: "...", viewport: {w,h}, ...}, ...];
// and then iterates that array to build cards + iframes. So checking the
// review file means checking what's inside ANIMATIONS — we extract it
// with a regex, undo the `<\/script` escape, and JSON.parse.
//
//   node tests/test-review.js
//   npm run test:review

const fs = require('fs');
const path = require('path');
const {
  REPO_ROOT,
  scenario,
  assert,
  assertEq,
  runH2v,
  summary,
} = require('./_test-harness');

// Extract the embedded animations array from a review page. Throws if the
// page doesn't have the expected shape — that itself catches structural
// regressions in buildReviewHtml.
function extractAnimations(html) {
  // The ANIMATIONS block spans multiple lines (JSON.stringify is called
  // with 2-space indent). The closing `];` of the OUTER array sits at
  // column 0; any nested `];` inside an animation's HTML string lives
  // on an indented line. So `\n];` is the unambiguous outer terminator.
  const m = html.match(/const ANIMATIONS = (\[[\s\S]*?\n\]);/);
  if (!m) {
    throw new Error(`review HTML missing "const ANIMATIONS = [...]" line`);
  }
  // safeJsonForScript escapes "</X" → "<\/X" where X is a letter or !.
  // That's a valid JS string escape AND a valid JSON escape (\/ → /),
  // so JSON.parse handles it natively — no pre-processing needed.
  return JSON.parse(m[1]);
}

console.log('test-review.js — h2v review HTML generation');
console.log('');

// ---------------------------------------------------------------------------
// 1. Single file → review page has 1 animation entry with the file's id
//    derived from filename.
// ---------------------------------------------------------------------------
scenario('single file → 1 animation entry, id from filename', ({ tmp }) => {
  const file = path.join(tmp, 'my-clip.html');
  fs.writeFileSync(file, '<!DOCTYPE html><html><head><meta name="h2v-duration" content="1s"></head><body>hi</body></html>');
  const out = path.join(tmp, 'review.html');
  const r = runH2v(['review', file, '--no-open', '--out', out]);
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);

  const anims = extractAnimations(fs.readFileSync(out, 'utf-8'));
  assertEq(anims.length, 1, 'animation count');
  assertEq(anims[0].id, 'my-clip', 'id from filename basename');
});

// ---------------------------------------------------------------------------
// 2. Bundle file → one animation entry per ANIMATION block, IDs preserved.
//    Validates the bundle parser feeds review correctly.
// ---------------------------------------------------------------------------
scenario('bundle file → entry per ANIMATION block, ids preserved', ({ tmp }) => {
  const out = path.join(tmp, 'review.html');
  const r = runH2v(['review', 'demo/bundle.html', '--no-open', '--out', out]);
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);

  const anims = extractAnimations(fs.readFileSync(out, 'utf-8'));
  assertEq(anims.length, 12, 'animation count (demo bundle has 12 blocks)');
  // Spot-check a few known IDs.
  const ids = anims.map((a) => a.id);
  assert(ids.includes('01-established-app'), `expected "01-established-app" in ids: ${ids}`);
  assert(ids.includes('12-cta'), `expected "12-cta" in ids: ${ids}`);
});

// ---------------------------------------------------------------------------
// 3. Directory → one entry per .html file in the directory (non-recursive,
//    skip rules apply).
// ---------------------------------------------------------------------------
scenario('directory → entry per .html file (skip rules honoured)', ({ tmp }) => {
  fs.writeFileSync(path.join(tmp, 'a.html'),
    '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  fs.writeFileSync(path.join(tmp, 'b.html'),
    '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  fs.writeFileSync(path.join(tmp, '.hidden.html'),
    '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  fs.writeFileSync(path.join(tmp, 'review.html'),
    '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const out = path.join(tmp, 'output.html');
  const r = runH2v(['review', '.', '--no-open', '--out', out], { cwd: tmp });
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);

  const anims = extractAnimations(fs.readFileSync(out, 'utf-8'));
  // Note: 'output.html' was written AFTER discovery; the discovery
  // happens at the top of runReview before we write. But we're inside
  // tmp/ — any 'review.html' literal-named file would be skipped, and
  // the dotfile too.
  const ids = anims.map((a) => a.id).sort();
  assertEq(ids, ['a', 'b'], 'ids (dotfile + review.html skipped)');
});

// ---------------------------------------------------------------------------
// 4. --out writes to the specified path (not a tmpfile).
// ---------------------------------------------------------------------------
scenario('--out path.html writes to the explicit path', ({ tmp }) => {
  const file = path.join(tmp, 'clip.html');
  fs.writeFileSync(file, '<html><head><meta name="h2v-duration" content="1s"></head></html>');
  const explicit = path.join(tmp, 'sub', 'output.html');
  const r = runH2v(['review', file, '--no-open', '--out', explicit]);
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  assert(fs.existsSync(explicit),
    `expected ${explicit} to exist after --out; stdout: ${r.stdout}`);
});

// ---------------------------------------------------------------------------
// 5. The animation's HTML content reaches the review's ANIMATIONS entry.
//    Use a marker token to verify.
// ---------------------------------------------------------------------------
scenario('original animation HTML reaches the review entry', ({ tmp }) => {
  const file = path.join(tmp, 'clip.html');
  const marker = 'HZ2V_REVIEW_TEST_TOKEN_XYZ123';
  fs.writeFileSync(file,
    `<!DOCTYPE html><html><head><meta name="h2v-duration" content="1s"></head><body><div>${marker}</div></body></html>`);
  const out = path.join(tmp, 'review.html');
  const r = runH2v(['review', file, '--no-open', '--out', out]);
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);

  const anims = extractAnimations(fs.readFileSync(out, 'utf-8'));
  assertEq(anims.length, 1, 'animation count');
  assert(anims[0].html.includes(marker),
    `expected marker "${marker}" in animation html: ${anims[0].html}`);
});

// ---------------------------------------------------------------------------
// 6. </script> escape canary. A fixture whose body contains a literal
//    </script> tag must not break the outer review page. The reviewer
//    page's safeJsonForScript replaces "</script" with "<\/script" inside
//    the embedded JSON; without that, the browser would see the closing
//    tag and terminate the outer <script>, breaking the page.
// ---------------------------------------------------------------------------
scenario('</script> in animation HTML doesn\'t break the review page', ({ tmp }) => {
  const file = path.join(tmp, 'clip.html');
  // A literal </script> string that, if not escaped, would close the
  // outer <script> tag prematurely. Placed inside an HTML comment so
  // even the inner-page browser ignores it; what we're testing is the
  // OUTER review page's robustness.
  fs.writeFileSync(file,
    `<!DOCTYPE html><html><head><meta name="h2v-duration" content="1s"></head><body><!-- </script> --></body></html>`);
  const out = path.join(tmp, 'review.html');
  const r = runH2v(['review', file, '--no-open', '--out', out]);
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);

  // The review page must still parse cleanly (the JS array intact). If
  // the escape were missing, extractAnimations would either fail or pull
  // out a truncated/garbage array.
  const html = fs.readFileSync(out, 'utf-8');
  const anims = extractAnimations(html);
  assertEq(anims.length, 1, 'animation count after </script> escape');
  // Belt-and-suspenders: the raw text of the ANIMATIONS block must NOT
  // contain a literal unescaped "</script>". If it does, the outer
  // <script> would terminate prematurely in any real browser.
  const animSection = html.match(/const ANIMATIONS = [\s\S]*?\];/)[0];
  assert(!/<\/script>/.test(animSection),
    `unescaped </script> in ANIMATIONS block — escape regressed: ${animSection.slice(0, 200)}`);
});

// ---------------------------------------------------------------------------
// 7. Per-file viewport meta is reflected in the review entry's viewport
//    field, which drives --anim-w / --anim-h CSS custom properties on
//    each iframe.
// ---------------------------------------------------------------------------
scenario('per-file viewport meta drives iframe sizing in review', ({ tmp }) => {
  const file = path.join(tmp, 'clip.html');
  fs.writeFileSync(file,
    '<html><head><meta name="h2v-duration" content="1s"><meta name="h2v-viewport" content="1080x1920"></head></html>');
  const out = path.join(tmp, 'review.html');
  const r = runH2v(['review', file, '--no-open', '--out', out]);
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);

  const anims = extractAnimations(fs.readFileSync(out, 'utf-8'));
  assertEq(anims.length, 1, 'animation count');
  assertEq(anims[0].viewport, { w: 1080, h: 1920 }, 'viewport object');
});

// ---------------------------------------------------------------------------
// 8. Live mode (no --out): single-file animations are loaded via
//    iframe.src = "file://…" so a browser refresh re-fetches from disk.
//    Each entry should carry `src` instead of `html` — verifies the
//    iterate-edit-refresh workflow is wired up correctly.
// ---------------------------------------------------------------------------
scenario('--no-serve: single file → src=file:// (static mode)', ({ tmp }) => {
  const file = path.join(tmp, 'clip.html');
  fs.writeFileSync(file,
    '<html><head><meta name="h2v-duration" content="1s"></head><body>x</body></html>');
  // --no-serve → static tmpfile path; --no-open prevents the cleanup wait loop.
  // (The default now runs a live server, which would block this sync harness.)
  const r = runH2v(['review', file, '--no-serve', '--no-open']);
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);

  // Pull the temp path out of stdout.
  const m = r.stdout.match(/Review page \([^)]+\): (\S+)/);
  assert(m, `expected "Review page (...): <path>" in stdout: ${r.stdout}`);
  const outPath = m[1];

  const anims = extractAnimations(fs.readFileSync(outPath, 'utf-8'));
  assertEq(anims.length, 1, 'animation count');
  assert(typeof anims[0].src === 'string', `live entry must carry src; got ${JSON.stringify(anims[0])}`);
  assert(anims[0].src.startsWith('file://'), `src must be a file:// URL; got ${anims[0].src}`);
  assert(anims[0].src.endsWith('/clip.html'), `src must point at the source file; got ${anims[0].src}`);
  // html is the inline-mode payload; live entries shouldn't carry it.
  assert(!('html' in anims[0]), `live entry must not duplicate html; got ${JSON.stringify(anims[0])}`);

  // Cleanup — the harness wipes tmp/, but the review page lives in os.tmpdir().
  try { fs.unlinkSync(outPath); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// 9. Live mode: bundle frames have no individual file on disk, so they
//    must still inline as srcdoc (carry `html`, not `src`).
// ---------------------------------------------------------------------------
scenario('--no-serve: bundle frames stay inlined (no individual files)', () => {
  const r = runH2v(['review', 'demo/bundle.html', '--no-serve', '--no-open']);
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);
  const m = r.stdout.match(/Review page \([^)]+\): (\S+)/);
  assert(m, `expected "Review page (...): <path>" in stdout: ${r.stdout}`);
  const outPath = m[1];

  const anims = extractAnimations(fs.readFileSync(outPath, 'utf-8'));
  assertEq(anims.length, 12, 'animation count');
  for (const a of anims) {
    assert(typeof a.html === 'string' && a.html.length > 0,
      `bundle frame ${a.id} must carry inlined html in live mode; got ${JSON.stringify(a).slice(0, 200)}`);
    assert(!('src' in a),
      `bundle frame ${a.id} must not carry src (no file on disk); got ${JSON.stringify(a).slice(0, 200)}`);
  }

  try { fs.unlinkSync(outPath); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// 10. --out mode forces inlining for every entry — even single-file
//     animations that would use file:// in live mode. The saved page
//     must be portable: no entry carries a `src` field that would
//     reference an unreachable path on someone else's machine.
// ---------------------------------------------------------------------------
scenario('--out: single file is inlined as srcdoc (portable)', ({ tmp }) => {
  const file = path.join(tmp, 'clip.html');
  fs.writeFileSync(file,
    '<html><head><meta name="h2v-duration" content="1s"></head><body>x</body></html>');
  const out = path.join(tmp, 'review.html');
  const r = runH2v(['review', file, '--no-open', '--out', out]);
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);

  const anims = extractAnimations(fs.readFileSync(out, 'utf-8'));
  assertEq(anims.length, 1, 'animation count');
  assert(typeof anims[0].html === 'string', `--out entry must carry inlined html`);
  assert(!('src' in anims[0]),
    `--out entry must NOT carry src (defeats portability); got ${JSON.stringify(anims[0]).slice(0, 200)}`);
});

// ---------------------------------------------------------------------------
// 11. Scale-to-fit preview structure. The review page must render each
//     iframe at its natural design pixel size inside a .frame-stage and
//     shrink it via transform: scale() driven by a ResizeObserver — this
//     is what prevents non-1280x720 / vertical animations from being
//     clipped. Assert the load-bearing pieces are present.
// ---------------------------------------------------------------------------
scenario('review page uses scale-to-fit stage (no clipping for any aspect)', ({ tmp }) => {
  const file = path.join(tmp, 'tall.html');
  fs.writeFileSync(file,
    '<html><head><meta name="h2v-duration" content="1s"><meta name="h2v-viewport" content="1080x1920"></head><body>x</body></html>');
  const out = path.join(tmp, 'review.html');
  const r = runH2v(['review', file, '--no-open', '--out', out]);
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);

  const html = fs.readFileSync(out, 'utf-8');
  assert(html.includes('frame-stage'), 'expected a .frame-stage wrapper');
  assert(/transform:\s*scale\(var\(--fit-scale/.test(html),
    'expected iframe transform: scale(var(--fit-scale ...)) for scale-to-fit');
  assert(html.includes('new ResizeObserver'),
    'expected a ResizeObserver to keep --fit-scale in sync with stage width');
  assert(html.includes('--max-stage-h'),
    'expected --max-stage-h clamp so portrait clips stay in the window');
});

// ---------------------------------------------------------------------------
// 12. Per-card view controls: each animation gets a "Full screen" button
//     (Fullscreen API) and an "Actual size" native-resolution button that
//     opens in a new tab (↗). The header also shows the aspect ratio.
//     Assert the load-bearing pieces are present in the generated page.
// ---------------------------------------------------------------------------
scenario('review page renders full-screen + actual-size buttons per card', ({ tmp }) => {
  const file = path.join(tmp, 'clip.html');
  fs.writeFileSync(file,
    '<html><head><meta name="h2v-duration" content="1s"><meta name="h2v-viewport" content="1920x1080"></head><body>x</body></html>');
  const out = path.join(tmp, 'review.html');
  const r = runH2v(['review', file, '--no-open', '--out', out]);
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);

  const html = fs.readFileSync(out, 'utf-8');
  assert(html.includes('Full screen'), 'expected a "Full screen" button');
  assert(html.includes('requestFullscreen'),
    'expected the Fullscreen API to drive the full-screen button');
  assert(/:fullscreen/.test(html), 'expected a :fullscreen CSS rule for letterboxing');
  assert(html.includes('openNative'),
    'expected an openNative() helper for native-resolution viewing');
  // Native view must open a scrollable wrapper (window.open + an iframe),
  // not the raw file — otherwise the animation's own body{overflow:hidden}
  // propagates to the viewport and the oversized canvas can't be scrolled.
  assert(html.includes('window.open'),
    'expected openNative to open a wrapper tab via window.open');
  assert(/createElement\(['"]iframe['"]\)/.test(html),
    'expected the native view to embed the animation in a native-sized iframe');
  assert(html.includes('Math.min'),
    'expected min(w,h) fit so fullscreen letterboxes instead of overflowing');
  // The native button now reads "Actual size", not "1:1".
  assert(html.includes('Actual size'),
    'expected the native button to read "Actual size"');
  // Icons are inlined Lucide SVGs (no external dependency). Check for the
  // distinctive path data of the maximize and external-link glyphs.
  assert(html.includes('M8 3H5a2 2 0 0 0-2 2v3'),
    'expected the inlined Lucide "maximize" icon on the full-screen button');
  assert(html.includes('M15 3h6v6'),
    'expected the inlined Lucide "external-link" icon on the actual-size button');
  assert(html.includes('stroke="currentColor"'),
    'expected inline SVG icons that inherit the button color');
  // Aspect ratio is shown next to the resolution, computed via aspectLabel.
  assert(html.includes('aspectLabel'),
    'expected an aspectLabel() helper to show the aspect ratio by the resolution');
});

// ---------------------------------------------------------------------------
// 13. Header de-duplication: for a single file id === source === name, so
//     the source span (which would just repeat the title) is omitted.
//     Bundle frames carry a "bundle/id" source, which IS shown.
// ---------------------------------------------------------------------------
scenario('single-file header omits the duplicate source span', ({ tmp }) => {
  const file = path.join(tmp, 'solo.html');
  fs.writeFileSync(file,
    '<html><head><meta name="h2v-duration" content="1s"></head><body>x</body></html>');
  const out = path.join(tmp, 'review.html');
  const r = runH2v(['review', file, '--no-open', '--out', out]);
  assert(r.code === 0, `exit ${r.code}; stderr: ${r.stderr}`);

  const html = fs.readFileSync(out, 'utf-8');
  // The guard that drops the duplicate must be present.
  assert(/a\.source !== label/.test(html),
    'expected the source-vs-name de-duplication guard');
});

// Note: the default live-server path (serve + SSE live-reload) is exercised by
// the standalone async integration test in tests/test-review-serve.js — the
// sync scenario harness here can't drive a long-running server.

summary();
