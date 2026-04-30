# h2v — Implementation Plan

> Reference document for executing the pivot from the Swing one-off into a
> generic HTML-animation → MP4 CLI. Designed to survive context compaction:
> if you're reading this fresh, everything you need to proceed is below.

## Context

`/Users/drewharvey/Projects/claude-animation-app` started as a one-off pipeline
for a Vaadin Swing Modernization storyboard video. The recording machinery
(Puppeteer + virtual JS clock + ffmpeg) is generic and proven; what's coupled
to Swing is the bundle file, the split frames, the review-page voiceovers, and
the README. The user generates animations at claude.ai (web) — sometimes one,
sometimes several — and wants a zero-config local exporter.

## Current state (snapshot)

```
/Users/drewharvey/Projects/claude-animation-app/
├── README.md                  Swing-specific instructions
├── all-frames-bundle.html     12 frames with FRAME_START markers
├── frames/                    Split bundle output (12 .html files)
├── build-review.js            Generates review.html from frames/
├── review.html                Generated, gitignored
├── record.js                  Working Puppeteer recorder (single-purpose)
├── package.json               Has puppeteer dep, almost-empty otherwise
├── package-lock.json
├── .gitignore                 Covers node_modules/, output/, captures/, review.html, etc.
└── output/                    MP4s (gitignored)
```

The user has confirmed `record.js` produces correct 4K @ 60fps output on their Mac.

## Decisions locked in — do NOT re-debate

| Concern | Decision |
|---|---|
| Package name | `html-to-video` |
| CLI command | `h2v` (primary), `html-to-video` (long alias) |
| Subcommand | `h2v export [<paths...>]` |
| No-arg behavior | Process every `*.html` in cwd (non-recursive) |
| Args behavior | Process specified files; for directories, expand to `*.html` in that dir (non-recursive) |
| Bundle detection | File contains `<!-- ===== FRAME_START` → bundle. Else single file. |
| Bundle duration source | Each marker's `capture_duration` |
| Single-file duration | 1) `<meta name="h2v-duration" content="Ns">`; 2) `--duration` flag; 3) default `10s` |
| FPS | 60 |
| Viewport | 1280×720 |
| Device scale factor | 3 (→ 3840×2160 = 4K) |
| Codec args | `-c:v libx264 -pix_fmt yuv420p -crf 18` |
| Default theme | dark (no filename suffix) |
| Light theme suffix | `-light` |
| `--theme both` | Emit both: dark with no suffix, light with `-light` |
| Output dir | `./output/` relative to cwd, always |
| Single-file output | `output/<input-basename>.mp4` |
| Bundle output | `output/<bundle-basename>/<frame-id>.mp4` (nested per bundle) |
| Skip rules (dir mode only) | dotfiles, `review.html`, anything inside `output/`, `node_modules/`, `frames/`. **Explicitly named file args bypass skip rules.** |
| Captures cleanup | Delete `captures/` in `finally`. Skip cleanup when `--no-ffmpeg`. |
| Browser override | `PUPPETEER_EXECUTABLE_PATH` env var hook stays |
| Bundle marker syntax | Keep current attributes; `filename` attr is now unused but tolerated |
| Distribution | `bin` entry in package.json. No npm publish in this work. |
| Tests / CI | None for now. |
| Review-page generator | Stays in `examples/swing-video/`, not part of the tool. |

## Watch out for (gotchas already hit)

- **`</script>` escaping** — if any future code embeds HTML inside a `<script>` block, replace `</` with `<\/` in the embedded JSON, otherwise the HTML tokenizer terminates the outer script early. Not expected to recur in `cli.js`, but flagged.
- **Virtual time = setVirtualTimePolicy + per-frame `document.getAnimations()` snap** — `Emulation.setVirtualTimePolicy` virtualizes only the JS *timer* clock (Date, setTimeout, rAF). The compositor (which runs CSS animations/transitions) has its own clock that ignores it. We tried `HeadlessExperimental.beginFrame` to drive the compositor; that doesn't work on macOS ("BeginFrameControl is not supported on MacOS yet"). The current approach instead pauses every Animation in the page after each tick and sets `currentTime` to the elapsed virtual time. This works on macOS, doesn't need any non-default browser flags, and uses public Web APIs. Don't switch to beginFrame; don't switch to chrome-headless-shell. SMIL animations (`<animate>`) aren't covered — if a future use case needs them, we'd need a different strategy.
- **Chrome on aarch64** — Google publishes no ARM64 Chrome; Puppeteer's bundled download falls back to x64 ELF that won't execute on aarch64. The `PUPPETEER_EXECUTABLE_PATH` hook is the workaround. Sandbox runs need this; user's Mac doesn't.
- **`captures/` cleanup must run in `finally`** — both success and exception paths. Already done in `record.js`; preserve.
- **Browser reuse** — launch one browser, open a new page per animation. Existing pattern; don't regress to one browser per file.
- **Capture duration regex** — current pattern is `(\d+)s`. Keep integer-seconds for now; don't generalize unless a use case appears.
- **macOS `.DS_Store`** — already in `.gitignore`. Don't accidentally commit one.

---

## Phase 1 — Move Swing-specific assets to `examples/swing-video/`

- [ ] Create `examples/swing-video/` directory
- [ ] `git mv all-frames-bundle.html examples/swing-video/all-frames-bundle.html`
- [ ] `git mv frames examples/swing-video/frames`
- [ ] `git mv build-review.js examples/swing-video/build-review.js`
- [ ] Update `build-review.js` paths: it currently reads `frames/` and writes `review.html` next to itself via `__dirname`. Confirm `__dirname` resolves correctly after the move (it does, since `__dirname` is the script's location). No code changes expected, just verify.
- [ ] Update `.gitignore`: `review.html` rule should still match anywhere; verify `examples/swing-video/review.html` is ignored (it will be — the rule has no leading slash).
- [ ] Write `examples/swing-video/README.md`: explains this is a reference example; describes the FRAME_START marker format; shows how to record it with `h2v export all-frames-bundle.html`; explains the optional `build-review.js` review page.

**Acceptance:**
- `node examples/swing-video/build-review.js` regenerates `examples/swing-video/review.html` without errors.
- The example dir is self-contained: bundle, frames, build-review, README.

---

## Phase 2 — Build `cli.js` (the real CLI, replacing `record.js`)

Single file at top level, `cli.js`, shebang `#!/usr/bin/env node`. The current `record.js` is the starting point — most logic carries over. Delete `record.js` at the end of this phase.

### 2a. Argument parser

Accept this surface (use plain JS, no `commander`/`yargs` dependency):

```
h2v export [<paths...>] [flags]
h2v --help | -h
h2v --version
```

Flags:
- `--duration <Ns | N>` (single-file only; ignored for bundles; default 10)
- `--fps <N>` (default 60)
- `--width <N>` (default 1280)
- `--height <N>` (default 720)
- `--scale <N>` (default 3)
- `--crf <N>` (default 18)
- `--theme <dark|light|both>` (default dark)
- `--out-dir <path>` (default `./output`)
- `--out <path>` (single-file shorthand for exact output filename; only valid when exactly one input animation will be produced)
- `--no-ffmpeg` (capture PNGs only; skip stitching; skip captures cleanup)
- `--dry-run` (print what would be recorded, exit 0)
- `--help`, `-h`
- `--version`

Reject unknown flags with a clear error.

### 2b. Input discovery

```
async function discoverInputs(args) {
  // No args → glob *.html in cwd (non-recursive), apply skip rules.
  // Args → for each:
  //   - If path is a file → include directly (skip rules NOT applied).
  //   - If path is a directory → glob *.html in it (non-recursive), apply skip rules.
  // De-dupe by absolute path.
}
```

Skip rules (directory expansion only):
- Filename starts with `.`
- Filename equals `review.html`
- Path contains `/output/`, `/node_modules/`, or `/frames/` segment

### 2c. Per-file mode detection

```
function detectMode(htmlText) {
  return /<!--\s*=+\s*FRAME_START\b/.test(htmlText) ? 'bundle' : 'single';
}
```

For bundles, parse out `{ id, title, filename, captureDurationSeconds }` per marker using the existing regex. For single files, parse out `<meta name="h2v-duration" content="...">` if present (be lenient: accept `5`, `5s`, `"5s"`).

### 2d. Plan construction

Each input file produces a list of "animation jobs":
```
{
  inputPath,            // absolute
  bundleId | null,      // 'frame-01' for bundle frames; null for single
  durationSeconds,
  totalFrames,          // duration * fps
  outputPath,           // absolute, includes -light suffix if applicable
  theme,                // 'dark' or 'light'
}
```

For `--theme both`, emit two jobs per animation (dark + light).
For bundles, emit one job per FRAME_START marker.

Collect all jobs across all inputs into a flat array before recording starts. Print a summary.

### 2e. Dry run

If `--dry-run`, print the plan (one line per job: `[bundle:frame-01] 5s × 60fps = 300 frames → output/all-frames-bundle/frame-01.mp4`) and exit.

### 2f. Recording loop

- Launch one browser (with `PUPPETEER_EXECUTABLE_PATH` honored).
- For each job: open new page, install clock override, navigate to `file://<inputPath>`, set `data-theme="light"` if needed, drive the clock with screenshots, close the page, run ffmpeg.
- For bundles, the same input file is loaded multiple times (once per frame) — this is fine because each frame's animation may share state. Actually, each FRAME in the Swing bundle is a separate self-contained `<!DOCTYPE html>` document inside the bundle. Loading the bundle URL with `file://` will only show the first one. **Implementation note:** for bundle mode, write each frame's content to a temp file (or use `data:` URLs / `setContent`) and load that. The cleanest approach: extract each frame's HTML between markers, write to `os.tmpdir()` as a temp file per frame, navigate to that, capture, delete. Or use `await page.setContent(html, { waitUntil: 'load' })` instead of `goto`. **Use `setContent`** — simpler, no temp files, and works correctly with `evaluateOnNewDocument` because navigation triggers it.

  **WAIT:** verify `evaluateOnNewDocument` fires for `setContent`. It does in modern Puppeteer (setContent navigates internally to `about:blank` and then writes the content; the override applies). If issues arise, fall back to writing temp files in `os.tmpdir()` and using `goto` with `file://`.

- Capture filenames: `output/<frame-id>/0001.png` etc., using `os.tmpdir()` for the captures dir to keep cwd clean. Actually — current behavior puts captures in `./captures/` so the cleanup logic finds them. **Keep `./captures/` in cwd** for consistency with existing behavior; the cleanup-on-finally handles it.

### 2g. Output naming logic

```
function outPathFor(job, opts) {
  const dir = opts.outDir;
  const themeSuffix = job.theme === 'light' ? '-light' : '';
  if (job.bundleId) {
    const bundleBase = path.basename(job.inputPath, path.extname(job.inputPath));
    return path.join(dir, bundleBase, `${job.bundleId}${themeSuffix}.mp4`);
  }
  if (opts.out && totalJobsForThisInput === 1) return path.resolve(opts.out);
  const base = path.basename(job.inputPath, path.extname(job.inputPath));
  return path.join(dir, `${base}${themeSuffix}.mp4`);
}
```

`mkdir -p` parent of each output path before ffmpeg runs.

### 2h. FFmpeg

Same args as today. Pass `-y` to overwrite. Verify `ffmpeg` exists on PATH at the start of the run (when `--no-ffmpeg` is not set); if missing, fail fast with: `error: ffmpeg not found on PATH. Install it (e.g. brew install ffmpeg) or pass --no-ffmpeg.`

### 2i. Cleanup

`captures/` removed in outer `finally`. Skip when `--no-ffmpeg`.

### 2j. Delete `record.js`

Once `cli.js` is green, `git rm record.js`.

**Acceptance:**
- `node cli.js --help` prints full flag reference
- `node cli.js export --dry-run examples/swing-video/all-frames-bundle.html` lists 12 jobs with correct durations and output paths
- `node cli.js export --dry-run` (no args) in a directory containing one HTML file shows one job
- Skip rules verified: a fixture dir containing `output/foo.html`, `frames/bar.html`, `.hidden.html`, `review.html`, `valid.html` → only `valid.html` is picked up in dir mode
- Explicit-arg bypass verified: `node cli.js export --dry-run output/foo.html` honors it (no skip)
- (If a working Chrome is reachable) full record of one bundle frame produces an MP4 at the expected path

---

## Phase 3 — Package as a CLI

- [ ] Update `package.json`:
  - `name`: `html-to-video`
  - `version`: `0.1.0`
  - `description`: short tagline
  - `bin`: `{ "h2v": "./cli.js", "html-to-video": "./cli.js" }`
  - `engines.node`: `>=18`
  - keep `dependencies.puppeteer`
- [ ] Ensure `cli.js` line 1 is `#!/usr/bin/env node`
- [ ] `chmod +x cli.js`
- [ ] Verify `npm link` (or `npm install -g .`) exposes `h2v` on PATH (skip the actual install if it touches global state — just confirm package.json is shaped right)

**Acceptance:**
- `package.json bin` is correct
- `cli.js` is executable
- `npx . export --help` works from project root

---

## Phase 4 — Rewrite `README.md`

Replace existing Swing-flavored README. New structure:

1. **Tagline** (one line)
2. **Quickstart** (5 lines max):
   ```
   npm install
   npm install -g .          # or use npx
   cd /path/to/animations
   h2v export
   ```
3. **Prerequisites**: Node 18+, ffmpeg on PATH. Note about ARM64 Linux + `PUPPETEER_EXECUTABLE_PATH`.
4. **How it works** (4–5 lines): virtual JS clock so screenshots are deterministic, ffmpeg stitches into MP4.
5. **Usage**:
   - `h2v export` — process all HTML in cwd
   - `h2v export file.html` — one file
   - `h2v export *.html dir/` — explicit list / dir
6. **Setting per-file duration**: explain the `<meta name="h2v-duration" content="Ns">` tag. Provide a copy-paste snippet for claude.ai prompts:
   > Include `<meta name="h2v-duration" content="Ns">` in `<head>` where N is how many seconds the animation needs to play.
7. **Bundle format** (brief): show one FRAME_START marker example, link to `examples/swing-video/`.
8. **Flag reference** — table or definition list, all flags with defaults.
9. **Examples**: link to `examples/swing-video/`.
10. **Limitations**: note CSS animations are real-time-driven (1 short paragraph).

**Acceptance:**
- README is fully self-contained for a fresh reader.
- No "Swing" outside the examples link.

---

## Phase 5 — End-to-end smoke test

- [ ] `node cli.js --help`
- [ ] `node cli.js export --dry-run examples/swing-video/all-frames-bundle.html` → 12 jobs
- [ ] `node cli.js export --dry-run --theme both examples/swing-video/all-frames-bundle.html` → 24 jobs
- [ ] Create a temp single-file HTML fixture with `<meta name="h2v-duration" content="3s">`, run `--dry-run`, confirm 3s × 60 = 180 frames
- [ ] `node examples/swing-video/build-review.js` still works
- [ ] `node --check cli.js` passes

If a working browser is available in this sandbox, attempt one real recording for confidence; if not, document that real recording must be verified by the user on their Mac.

---

## Phase 6 — Commit

- [ ] `git status` — review all changes
- [ ] `git add` (specific files, not `-A`):
  - `cli.js`
  - `package.json`, `package-lock.json` (if changed)
  - `README.md`
  - `examples/swing-video/` (and the moves it contains)
  - `.gitignore` (if changed)
  - `PLAN.md` (this file)
- [ ] `git rm` removed files (`record.js`, top-level `all-frames-bundle.html`, top-level `frames/`, top-level `build-review.js`)
- [ ] Commit with HEREDOC message describing the pivot. Include the `Co-Authored-By` line.
- [ ] **Do NOT push.** User pushes themselves.
- [ ] Print the commit summary so the user can review.

---

## Done definition

- `h2v export` from a directory of claude.ai-generated HTML files produces 4K MP4s in `./output/`.
- Bundle files are auto-detected and produce one MP4 per FRAME_START marker.
- Single files use the meta-tag duration, the `--duration` flag, or default 10s, in that priority.
- The Swing example lives entirely under `examples/swing-video/` and still records correctly.
- README is generic; no Swing references at top level.
- Repo committed locally. User will push.

## When in doubt

- Match existing `record.js` defaults and structure rather than re-designing.
- Prefer fewer flags + obvious behavior over flexibility.
- Don't add tests, abstractions, or features that aren't called out here.
- If something is genuinely ambiguous and not covered above, stop and ask the user; do not guess.
