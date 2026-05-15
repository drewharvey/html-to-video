#!/usr/bin/env node
//
// Correctness tests for `h2v bundle`. No Puppeteer / Chromium dependency
// — bundle is pure file-read-and-write, so this whole file runs in well
// under a second and is suitable for CI on any host.
//
//   node tests/test-bundle.js
//   npm run test:bundle

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

// We parse h2v bundles using the same regex shape `cli.js` uses internally.
// Duplicated here intentionally so the test is independent of cli.js's
// exports — if someone refactors the regex, the test still validates the
// emitted format against an explicit specification.
const ANIMATION_BLOCK_RE =
  /<!--\s*=+\s*(?:ANIMATION|FRAME)_START\s+(.*?)\s*=+\s*-->\s*([\s\S]*?)\s*<!--\s*=+\s*(?:ANIMATION|FRAME)_END\b[^>]*?-->/g;
const ATTR_RE = /(\w+)="([^"]*)"/g;

function parseAttrs(s) {
  const out = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s)) !== null) out[m[1]] = m[2];
  return out;
}

function parseBundleBlocks(html) {
  const blocks = [];
  let m;
  ANIMATION_BLOCK_RE.lastIndex = 0;
  while ((m = ANIMATION_BLOCK_RE.exec(html)) !== null) {
    blocks.push({ attrs: parseAttrs(m[1]), content: m[2].trim() });
  }
  return blocks;
}

// =========================================================================
// Scenarios
// =========================================================================

console.log('test-bundle.js — h2v bundle correctness');
console.log('');

// ---------------------------------------------------------------------------
// 1. Round-trip equivalence. The single highest-leverage test: bundling
//    demo/animations/ should produce a bundle whose block set matches
//    demo/bundle.html. Both fixtures are committed to the repo, kept in
//    sync by convention; this test enforces that convention end-to-end.
// ---------------------------------------------------------------------------
scenario('demo/animations/ ≡ demo/bundle.html (round-trip)', ({ tmp }) => {
  const outFile = path.join(tmp, 'roundtrip.html');
  const r = runH2v(['bundle', 'demo/animations/', '--out', outFile]);
  assert(r.code === 0, `h2v bundle exited ${r.code}\nstderr: ${r.stderr}`);

  const generated = parseBundleBlocks(fs.readFileSync(outFile, 'utf-8'));
  const reference = parseBundleBlocks(
    fs.readFileSync(path.join(REPO_ROOT, 'demo/bundle.html'), 'utf-8')
  );

  // Same set of ids
  const gIds = generated.map((b) => b.attrs.id).sort();
  const rIds = reference.map((b) => b.attrs.id).sort();
  assertEq(gIds, rIds, 'animation id set');

  // Per-id: same capture_duration, viewport, themes. The reference bundle
  // carries extra `title` and `filename` attributes that we don't emit
  // (they're documented as tolerated-and-ignored); skip those.
  const rByid = Object.fromEntries(reference.map((b) => [b.attrs.id, b.attrs]));
  for (const block of generated) {
    const ref = rByid[block.attrs.id];
    assertEq(block.attrs.capture_duration, ref.capture_duration,
      `${block.attrs.id} capture_duration`);
    assertEq(block.attrs.viewport || null, ref.viewport || null,
      `${block.attrs.id} viewport`);
    assertEq(block.attrs.themes || '', ref.themes || '',
      `${block.attrs.id} themes`);
  }
});

// ---------------------------------------------------------------------------
// 2. Per-meta extraction from a standalone file. Each h2v-* meta should
//    end up in the corresponding marker attribute.
// ---------------------------------------------------------------------------
scenario('standalone file metadata → marker attributes', ({ tmp }) => {
  const file = path.join(tmp, 'metadata-test.html');
  fs.writeFileSync(file, `<!DOCTYPE html>
<html><head>
<meta name="h2v-duration" content="7.5s">
<meta name="h2v-viewport" content="1080x1080">
<meta name="h2v-themes" content="dark,light,vibrant">
</head><body>hello</body></html>
`);
  const outFile = path.join(tmp, 'meta.html');
  const r = runH2v(['bundle', file, '--out', outFile]);
  assert(r.code === 0, `h2v bundle exited ${r.code}\nstderr: ${r.stderr}`);

  const blocks = parseBundleBlocks(fs.readFileSync(outFile, 'utf-8'));
  assertEq(blocks.length, 1, 'block count');
  const a = blocks[0].attrs;
  assertEq(a.id, 'metadata-test', 'id (from filename)');
  assertEq(a.capture_duration, '7.5s', 'capture_duration');
  assertEq(a.viewport, '1080x1080', 'viewport');
  assertEq(a.themes, 'dark,light,vibrant', 'themes');
});

// ---------------------------------------------------------------------------
// 3. Missing h2v-duration meta. Should fall back to DEFAULTS.duration
//    (10s — match the value in cli.js) AND emit a stderr note. The user
//    needs to see this; silently inventing durations would hide authoring
//    mistakes.
// ---------------------------------------------------------------------------
scenario('missing h2v-duration meta → fallback + stderr note', ({ tmp }) => {
  const file = path.join(tmp, 'no-duration.html');
  fs.writeFileSync(file, '<!DOCTYPE html><html><head></head><body>hi</body></html>');
  const outFile = path.join(tmp, 'out.html');
  const r = runH2v(['bundle', file, '--out', outFile]);
  assert(r.code === 0, `h2v bundle exited ${r.code}\nstderr: ${r.stderr}`);
  assert(
    /no h2v-duration meta, using default \d+s/.test(r.stderr),
    `expected stderr note about default duration, got: ${JSON.stringify(r.stderr)}`
  );

  const blocks = parseBundleBlocks(fs.readFileSync(outFile, 'utf-8'));
  assertEq(blocks.length, 1, 'block count');
  // Default is DEFAULTS.duration in cli.js (currently 10). We check that
  // some positive duration was emitted rather than hard-coding 10 — the
  // default may change over time and this test shouldn't break trivially.
  assert(
    /^\d+(?:\.\d+)?s$/.test(blocks[0].attrs.capture_duration),
    `capture_duration didn't match Ns pattern: "${blocks[0].attrs.capture_duration}"`
  );
});

// ---------------------------------------------------------------------------
// 4. Decompose-and-merge: an input file that's already a bundle should be
//    exploded into individual animations, and merge cleanly with a separate
//    standalone file in the same invocation.
// ---------------------------------------------------------------------------
scenario('decompose existing bundle + merge with standalone file', ({ tmp }) => {
  // Source bundle with 2 entries
  const srcBundle = path.join(tmp, 'src-bundle.html');
  fs.writeFileSync(srcBundle, [
    '<!-- ===== ANIMATION_START id="from-bundle-a" capture_duration="3s" ===== -->',
    '<html><body>a</body></html>',
    '<!-- ===== ANIMATION_END id="from-bundle-a" ===== -->',
    '',
    '<!-- ===== ANIMATION_START id="from-bundle-b" capture_duration="4s" viewport="800x600" ===== -->',
    '<html><body>b</body></html>',
    '<!-- ===== ANIMATION_END id="from-bundle-b" ===== -->',
  ].join('\n'));

  // Standalone file
  const standalone = path.join(tmp, 'standalone.html');
  fs.writeFileSync(standalone,
    '<!DOCTYPE html><html><head><meta name="h2v-duration" content="2s"></head><body>c</body></html>'
  );

  const outFile = path.join(tmp, 'merged.html');
  const r = runH2v(['bundle', srcBundle, standalone, '--out', outFile]);
  assert(r.code === 0, `h2v bundle exited ${r.code}\nstderr: ${r.stderr}`);

  const blocks = parseBundleBlocks(fs.readFileSync(outFile, 'utf-8'));
  assertEq(blocks.length, 3, 'block count (2 from bundle + 1 standalone)');
  assertEq(
    blocks.map((b) => b.attrs.id),
    ['from-bundle-a', 'from-bundle-b', 'standalone'],
    'ids in input order'
  );
  assertEq(blocks[1].attrs.viewport, '800x600',
    'viewport preserved through decompose');
});

// ---------------------------------------------------------------------------
// 5. Duplicate ids → exit 2 with both source paths named in stderr. The
//    common cause is two same-basenamed files from different dirs; the
//    error must surface enough detail to let the user fix the collision.
// ---------------------------------------------------------------------------
scenario('duplicate ids across inputs → exit 2 + both paths in stderr', ({ tmp }) => {
  fs.mkdirSync(path.join(tmp, 'dir-a'));
  fs.mkdirSync(path.join(tmp, 'dir-b'));
  const fileA = path.join(tmp, 'dir-a', 'clip.html');
  const fileB = path.join(tmp, 'dir-b', 'clip.html');
  fs.writeFileSync(fileA, '<html><head><meta name="h2v-duration" content="1s"></head><body>a</body></html>');
  fs.writeFileSync(fileB, '<html><head><meta name="h2v-duration" content="1s"></head><body>b</body></html>');

  const r = runH2v(['bundle', fileA, fileB, '--out', path.join(tmp, 'out.html')]);
  assertEq(r.code, 2, 'exit code');
  assert(/duplicate animation id/.test(r.stderr), `stderr should mention duplicate id: ${JSON.stringify(r.stderr)}`);
  assert(r.stderr.includes(fileA), `stderr should name first source path (${fileA}): ${JSON.stringify(r.stderr)}`);
  assert(r.stderr.includes(fileB), `stderr should name second source path (${fileB}): ${JSON.stringify(r.stderr)}`);
});

// ---------------------------------------------------------------------------
// 6. Default output path when a single positional arg is a directory:
//    h2v bundle anims/ → output/anims.html
// ---------------------------------------------------------------------------
scenario('default --out (single dir) → output/<dirname>.html', ({ tmp }) => {
  // Set up tmp as a self-contained workspace so the test doesn't write to
  // the real repo's output/. We need an `anims/` subdir with an animation
  // so the bundle command has something to bundle.
  fs.mkdirSync(path.join(tmp, 'anims'));
  fs.writeFileSync(
    path.join(tmp, 'anims', 'one.html'),
    '<html><head><meta name="h2v-duration" content="1s"></head><body></body></html>'
  );
  const r = runH2v(['bundle', 'anims/'], { cwd: tmp });
  assert(r.code === 0, `h2v bundle exited ${r.code}\nstderr: ${r.stderr}`);
  const expectedPath = path.join(tmp, 'output', 'anims.html');
  assert(fs.existsSync(expectedPath),
    `expected ${expectedPath} to exist; stdout: ${r.stdout}`);
});

// ---------------------------------------------------------------------------
// 7. Default output path with mixed inputs (not a single dir):
//    falls back to output/bundle.html.
// ---------------------------------------------------------------------------
scenario('default --out (mixed inputs) → output/bundle.html', ({ tmp }) => {
  fs.writeFileSync(
    path.join(tmp, 'a.html'),
    '<html><head><meta name="h2v-duration" content="1s"></head><body></body></html>'
  );
  fs.writeFileSync(
    path.join(tmp, 'b.html'),
    '<html><head><meta name="h2v-duration" content="1s"></head><body></body></html>'
  );
  const r = runH2v(['bundle', 'a.html', 'b.html'], { cwd: tmp });
  assert(r.code === 0, `h2v bundle exited ${r.code}\nstderr: ${r.stderr}`);
  const expectedPath = path.join(tmp, 'output', 'bundle.html');
  assert(fs.existsSync(expectedPath),
    `expected ${expectedPath} to exist; stdout: ${r.stdout}`);
});

// ---------------------------------------------------------------------------
// 8. Empty input set → exit 2 with a clear message.
// ---------------------------------------------------------------------------
scenario('empty input set → exit 2', ({ tmp }) => {
  fs.mkdirSync(path.join(tmp, 'empty-dir'));
  const r = runH2v(['bundle', 'empty-dir/'], { cwd: tmp });
  assertEq(r.code, 2, 'exit code');
  assert(/no \.html files matched/.test(r.stderr),
    `expected stderr to mention no html files matched: ${JSON.stringify(r.stderr)}`);
});

summary();
