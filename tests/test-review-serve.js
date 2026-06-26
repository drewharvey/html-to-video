'use strict';

// Integration test for `h2v review`'s default live server (serve + SSE
// live-reload). The shared scenario harness is synchronous and can't drive a
// long-running server, so this file does its own async orchestration: spawn the
// server on a tmp fixture, probe it over HTTP, edit the fixture, and assert the
// reload is pushed. Run via `npm run test:review-serve` (part of test:e2e).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CLI = path.join(__dirname, '..', 'cli.js');
let failures = 0;
function ok(cond, msg) {
  if (cond) {
    console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
  } else {
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url, { sse } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (sse) { resolve({ status: res.statusCode, headers: res.headers, res }); return; }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('request timeout')));
  });
}

(async () => {
  console.log('test-review-serve.js — h2v review live server');
  console.log('');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2v-serve-'));
  const fixture = path.join(dir, 'clip.html');
  const page = (body) =>
    `<html><head><meta name="h2v-duration" content="1s"></head><body>${body}</body></html>`;
  fs.writeFileSync(fixture, page('ORIGINAL'));

  // Ephemeral port (default), no browser. Run from the fixture dir.
  const proc = spawn('node', [CLI, 'review', '--no-open'], { cwd: dir });
  let out = '';
  let url = null;
  proc.stdout.on('data', (c) => {
    out += c;
    const m = out.match(/Review server \([^)]*\): (http:\/\/\S+)/);
    if (m) url = m[1];
  });
  proc.stderr.on('data', () => { /* swallow */ });

  try {
    for (let i = 0; i < 60 && !url; i++) await sleep(100);
    ok(!!url, `server printed a URL${url ? ` (${url})` : ''}`);
    if (!url) return;

    const p1 = await get(url);
    ok(p1.status === 200, 'GET / → 200');
    ok(/__h2v_reload/.test(p1.body), 'page injects the live-reload client');
    ok(/const ANIMATIONS/.test(p1.body), 'page has the ANIMATIONS array');
    ok(/ORIGINAL/.test(p1.body), 'page embeds the current animation content');

    const sse = await get(url + '__h2v_reload', { sse: true });
    ok(sse.status === 200 && /text\/event-stream/.test(sse.headers['content-type'] || ''),
      'SSE endpoint serves text/event-stream');

    // Editing a watched file pushes a reload over SSE...
    let events = '';
    sse.res.on('data', (c) => (events += c));
    await sleep(200);
    fs.writeFileSync(fixture, page('EDITED'));
    await sleep(900);
    ok(/data: reload/.test(events), 'editing a watched file pushes a reload over SSE');
    sse.res.destroy();

    // ...and the server re-reads the file, so the reloaded page is current.
    const p2 = await get(url);
    ok(/EDITED/.test(p2.body), 'server re-reads on each request (edit reflected)');

    // 404 for unknown paths.
    const p404 = await get(url + 'nope');
    ok(p404.status === 404, 'unknown path → 404');
  } finally {
    proc.kill('SIGINT');
    await sleep(200);
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('');
  if (failures) {
    console.log(`\x1b[31m${failures} check(s) failed.\x1b[0m`);
    process.exit(1);
  }
  console.log('\x1b[32mall checks passed.\x1b[0m');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
