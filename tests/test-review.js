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

summary();
