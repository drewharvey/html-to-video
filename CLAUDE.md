# CLAUDE.md — h2v / html-to-video

A CLI (`h2v`) with two subcommands:
- `h2v export` — converts HTML animations to video files via Puppeteer + ffmpeg. Default output is 4K 60fps h264 MP4. Use `--quality-preset max|high|standard|draft` to switch between archival, high-quality-distribution, default, and fast-iteration tiers; or override individual knobs with `--codec` (libx264|libx265|libvpx-vp9|prores_ks), `--container` (mp4|mov|webm), `--capture-format` (jpeg|png), `--capture-quality`, `--crf`, `--fps`, `--width`, `--height`, `--scale`, `--slowdown`. Explicit flags always override the preset.
- `h2v review` — builds a single self-contained HTML page that previews every animation in the given paths via `<iframe srcdoc>`. Default: writes to a tmpfile, opens in the browser, deletes on `SIGINT`. Flags: `--out <path>` (save to specific location, implies keep), `--no-open` (just print path), `--keep` (don't auto-delete).

Entry point: `cli.js`. Designed for the workflow of generating animations at claude.ai and exporting/inspecting them locally.

The bundle marker format uses `<!-- ===== ANIMATION_START id="..." capture_duration="Ns" ===== -->` / `ANIMATION_END`. The legacy `FRAME_START` / `FRAME_END` is still accepted for backward compatibility (regex in `cli.js` matches either).

## Hard rules (load-bearing — read before changing anything in `cli.js`)

The animation-timing approach in `cli.js` is the result of many failed iterations. **Do not** "fix" or "improve" it without first re-reading the trade-off below.

1. **Don't try to pause Chromium's clocks.** Every variant of pausing — `Emulation.setVirtualTimePolicy({policy:'pause'})`, `Animation.setPlaybackRate(0)`, `anim.pause()` — eventually causes `Page.captureScreenshot` to hang because Chromium's compositor stops scheduling BeginFrames when there's nothing to render.
2. **Don't try `HeadlessExperimental.beginFrame` to drive frame-time.** It returns `Protocol error: BeginFrameControl is not supported on MacOS yet`. This is a hard Chromium limitation, not fixable from our side.
3. **Don't switch to `chrome-headless-shell` (`headless: 'shell'`).** Same macOS BeginFrame block applies, plus it adds a separate binary download dependency for nothing.
4. **Don't add Web Animations API micromanagement** (walking `document.getAnimations()`, `setCurrentTime`, `commitStyles`, `cancel`). All variants either don't reach the compositor's render or hang the screenshot pipeline as in (1).

The one approach that works on every platform Puppeteer supports: **slow everything by factor `S`** (default `6`, configurable via `--slowdown`). The default was 10 originally; it was lowered to 6 after the JPEG q=95 capture-format change brought screenshot p95 down to ~100 ms at 4K, leaving comfortable margin inside the per-tick budget.

## How animation timing actually works

`cli.js` synchronizes JS-driven and CSS-driven animations like this:

- **JS layer** (injected via `page.evaluateOnNewDocument` before any page script):
  - `setTimeout` / `setInterval` delays multiplied by `S`
  - `performance.now()` returns `(real-elapsed-since-load) / S`
  - `Date.now()` returns `loadEpoch + (real-elapsed-since-load) / S`
  - `requestAnimationFrame` callback timestamps scaled the same way
- **CSS layer** (CDP, after navigation): `Animation.setPlaybackRate({ playbackRate: 1 / S })`
- **Capture loop**: sleep `(1000 / fps) × S` ms between screenshots; encode the resulting PNGs at `fps`. Playback is at the original speed.

Wall time per recording = animation duration × S. With S=6, a 5-second animation takes ~30 seconds. Tunable via `--slowdown` (raise on slow machines if desync appears, lower if screenshots have headroom).

This is the entirety of the recording strategy — the recordJob function in cli.js is short. If you need to change it, do so with full awareness of the rule above.

## The seek driver (auto-detected alternative to slowdown)

`recordJob` has two **frame drivers**, chosen per-job by capability detection — the slowdown/play approach above is the universal fallback; the seek driver is a fast path for cooperating pages.

- A page is **seek-aware** if it exposes `window.seek` (a function). Such a page's scene is a pure function of time: `window.seek(ms)` sets the entire scene to its state at `ms`, deterministically. No timers, no CSS `@keyframes`/transitions for choreography.
- **Detection:** after navigation, `recordJob` probes `typeof window.seek === 'function'`. Present → seek driver. Absent → play driver (slowdown). The presence of the function is *both* the capability signal and the behavioral hook — there is no separate metadata global (duration/viewport still come from the meta tags h2v parses pre-launch).
- **`window.__SCRUB__ = true` is injected unconditionally before load**, alongside the slowdown shim, in *both* the `goto` and `setContent` paths. It tells a seek-aware page not to autoplay (render frame 0, wait for `seek`). For every other page it's an inert global. It must be set before page scripts run, but the driver can only be detected *after* load — so it's set unconditionally and the driver decided afterward. **Don't gate the `__SCRUB__` injection on detection; the ordering makes that impossible.**
- **Seek capture loop:** wait for `document.fonts.ready` (+ a short settle) — the play path relies on the slowdown to give fonts time, but seek captures frame 0 almost immediately — then for `i` in `[0, totalFrames)`: `seek(i × 1000/fps)`, screenshot. No pacing sleep (that deletion is the win: wall time ≈ N screenshots, not `duration × slowdown`). Frames are written 1-based on disk (`0001…N`) to match `ffmpegStitch`'s `-start_number 1`, same as the play path.
- **The seek driver never touches the CDP `Animation` domain** (no `setPlaybackRate`) — it drives state explicitly, so there's no clock to slow. That block is gated under `driver === 'play'`.
- **No flag.** Driver selection is auto-only by design (see the export-contract discussion). Each job logs which driver it used (`driver: seek …` / `driver: slowdown N×`) so a silent fallback is visible. If a forcing/asserting flag is ever needed, add a tri-state `--driver auto|seek|play`, not a bare `--seek`. Fixture: `tests/seek-test.html`; test: `npm run test:seek`.
- **Frame-sharding (`recordJobSharded`).** Gated to a **single-job run** with `--concurrency > 1` (`mode === 'frameshard'` in `main`): the otherwise-idle budget splits that seek job's frame range across browsers (one browser per shard — Chrome serializes screenshots intra-process, same reason as `runJobsParallel`). Only the seek driver can do this — `seek()` is order-independent, so disjoint ranges are correct in parallel; the play driver is inherently sequential and stays single-browser. **Don't widen the trigger to `jobs.length < concurrency`** — with 2+ jobs that would run them sequentially-with-sharding and regress multi-job batches (un-shardable play jobs especially); 2+ jobs must stay on the `jobpool` path. Each shard writes frames by global 1-based index into the shared captureDir → one contiguous `0001..N` sequence for ffmpeg. Worker 0's load doubles as the driver probe (not wasted). `SEEK_SHARD_MIN_FRAMES` (60) keeps shards big enough to amortize their page-load. The screenshot is ~99% of per-frame cost, so this is ~2.5×+ at K=4. The memory check uses `peakBrowsers` (frameshard can use the full budget on its one job).
- **Warm-up replay in `captureSeekRange` is load-bearing — do not remove.** The contract says `seek(ms)` is a pure function of time, but real engines (animation-kit's included) carry incremental state: jumping cold to a mid-timeline frame renders *differently* than arriving there frame-by-frame (verified — `seek0+jump ≠ sequential`). So each shard replays `seek()` from frame 0 to its start frame *without screenshotting* before capturing, reproducing the single-pass state. It's cheap (`seek()` ≈ 1 ms vs ≈ 25–55 ms/screenshot) and makes sharded output byte-identical to single-worker. Removing it silently corrupts every shard but the first for order-dependent animations (they still look plausible). `tests/seek-stateful-test.html` (deliberately order-dependent) is the regression guard; it fails if warm-up is removed.

## Failed approaches (don't repeat)

Each row is something that was tried in multiple commits and **definitely** doesn't work. If you find yourself reaching for one, stop.

| Attempted | Failure mode |
|---|---|
| `setVirtualTimePolicy` (CDP) only | Virtualizes JS timers; compositor still uses real time. CSS transitions desync. |
| Same + walk `document.getAnimations()` and `setCurrentTime` per frame | JS sees correct currentTime; rendered output still reflects real-time progress (compositor cache, not the JS-set value). |
| Same + `anim.pause()` | `Page.captureScreenshot` hangs indefinitely. No active animations → no BeginFrame → no frame to capture. |
| `HeadlessExperimental.beginFrame` to drive compositor frame-time | `BeginFrameControl is not supported on MacOS yet`. Hard block. |
| Switch to `chrome-headless-shell` (`headless: 'shell'`) for the beginFrame domain | Same macOS block. Adds binary-download burden. |
| `Target.createTarget` with `enableBeginFrameControl: true` to satisfy beginFrame | Still hits the macOS block. |
| `Animation.setPlaybackRate(0)` via CDP (timeline-level pause) | Same hang as `anim.pause()` — no work for compositor. |
| `commitStyles()` to freeze visible state | The animation continues advancing in real time before commitStyles reads it; written value is wrong. |

## Sandbox testing (aarch64 Linux only — user runs on macOS)

Google publishes no ARM64 Chrome. Puppeteer's bundled download is x86_64 ELF (won't execute). Ubuntu's `chromium` package is a snap shim that doesn't run inside this container.

For end-to-end testing in this sandbox, use Playwright's Chromium (has ARM64 builds):
```
npx playwright install chromium
# PUPPETEER_EXECUTABLE_PATH is already set in /etc/sandbox-persistent.sh
```

`cli.js` honors `PUPPETEER_EXECUTABLE_PATH`; on the user's macOS this env var is not set, and Puppeteer uses its own bundled Chrome.

## Test fixture for fast iteration

`tests/sync-test.html` is a 1.5-second, low-resolution-friendly fixture with two parallel bars:
- Top: CSS `transition: width 1s linear` (green)
- Bottom: JS `setInterval` writing `width = X%` (blue)

If they fill in lockstep, synchronization is working. Inspect by exporting to MP4 (or JPEGs with `--no-ffmpeg`), then `Read` an output frame — Claude Code reads images.

Quick run (low-res, ~9 s wall time at the default 6× slowdown):
```
node cli.js export tests/sync-test.html --width 640 --height 360 --scale 1
ffmpeg -y -i output/sync-test.mp4 -ss 0.5 -frames:v 1 /tmp/mid.png
```
Both bars should read ~50 % at the midpoint (0.5 s into the 1.5 s clip). At 1.0 s both should be at 100 % (the animation completes by then; the last 0.5 s shows the settled state).

## In-repo demo

`demo/` exercises all three usage modes against real content:
- Single file: `h2v export demo/animations/09-automation.html`
- Directory: `h2v export demo/animations/`
- Bundle: `h2v export demo/bundle.html`

The 12 animations exist in two forms (`bundle.html` markers and individual files in `animations/` with `<meta name="h2v-duration">` tags) so the same content can be tested under each mode. See `demo/README.md`.

## Codebase shape

```
cli.js                          # one file, only dep is puppeteer
package.json                    # bin: { h2v, html-to-video } → cli.js;
                                # docs:sync / docs:check scripts
README.md                       # slim human-facing landing page + doc map
docs/                           # split docs (see "Documentation layout" below)
  authoring.md                  # HTML-side contract: meta tags, themes,
                                # bundle markers, recording hooks
  cli.md                        # operator reference; contains the
                                # auto-synced --help block
  internals.md                  # recording mechanism, capture format,
                                # parallel job model
scripts/
  sync-help-docs.js             # regenerates the --help block in docs/cli.md
demo/                           # smoke-test fixtures for the three usage modes
  bundle.html                   # 12-animation bundle with ANIMATION_START markers
  animations/                   # the same 12 animations as standalone files
                                # (each with <meta name="h2v-duration">)
  README.md
.gitignore                      # node_modules, output, captures, review.html, .DS_Store
```

## Documentation layout

The README is the human-facing landing page (and the file most agents parse first when discovering the project). The deeper content is split by audience under `docs/`:

- **`docs/authoring.md`** — the HTML-side contract. What meta tags h2v reads, theme model, bundle marker format, `data-h2v-hide` / `data-h2v-recording` hooks. **This is the file a Claude skill (or any other tool generating HTML for h2v) should read.** Self-contained — readable without the rest.
- **`docs/cli.md`** — operator reference. Contains the auto-synced `h2v --help` block (between `<!-- BEGIN: auto-generated ... -->` markers) plus deeper sections on quality presets, codec/container details, parallel recording, output paths, etc.
- **`docs/internals.md`** — how recording works under the hood. Time-slowdown trick, capture format choice, parallel job model. Cross-references this file for the failed-approaches table and design invariants.
- **`CLAUDE.md`** (this file) — design invariants, failed approaches, "things that aren't broken." Required reading before modifying `cli.js`.

## --help / docs/cli.md sync workflow

**`HELP_TEXT` in `cli.js` is the single source of truth for the flag list.** `docs/cli.md` contains an auto-managed block (between `<!-- BEGIN: auto-generated from \`h2v --help\` ... -->` and `<!-- END: auto-generated -->` markers) that mirrors `h2v --help` verbatim.

**After modifying `HELP_TEXT` in `cli.js`** (adding a flag, changing a default, rewording a description), run:

```
npm run docs:sync
```

This regenerates the auto-managed block. **Always run it before committing flag changes.**

`npm run docs:check` is the CI-friendly variant — it exits 1 if the block is out of sync without modifying anything. The `docs-check` GitHub Actions workflow (`.github/workflows/docs-check.yml`) runs it on every push to main and on PRs targeting main, so drift can't reach `main` even if `docs:sync` is forgotten locally. Useful as a local precommit hook too.

The script is `scripts/sync-help-docs.js`. It spawns `node cli.js --help`, captures stdout, and replaces only the content between the markers. Anything outside the markers (including the prose in the rest of `docs/cli.md`) is untouched.

**If a flag change also affects prose elsewhere in `docs/cli.md`** (e.g. a new flag warrants a deeper section, or you renamed something referenced in the "Quality presets" table), update those sections by hand alongside running `docs:sync`. The script only touches the auto-managed block.

## Things that aren't broken — don't change them

- The bundle marker format (`<!-- ===== ANIMATION_START id="..." capture_duration="Ns" ===== -->`, with `FRAME_START` accepted as a legacy alias) — extra attributes like `filename` are tolerated and ignored.
- The single-file metadata convention (`<meta name="h2v-duration" content="Ns">`).
- The single-file viewport convention (`<meta name="h2v-viewport" content="WxH">`) and bundle marker `viewport="WxH"` attribute. Format is `<width>x<height>` in CSS pixels, integers only — `parseBundleFrames` and `extractViewport` enforce this. Default when absent is `DEFAULT_VIEWPORT` (1280x720). Consumed by both `buildPlan` (per-job recording viewport for `h2v export`) and `buildReviewAnimations` → `buildReviewHtml` (per-iframe sizing for `h2v review`). The CLI's `--width`/`--height` flags override the meta for the whole run; they're a coupled pair tracked via `widthExplicit`/`heightExplicit` so passing either makes both override every per-animation viewport. Don't rename or change the format without updating both downstream consumers.
- Output-resolution model: `computeRenderPlan(width, height, opts)` → `{ renderScale, outputHeight }`, called per job in `makeJob`. Three modes: **(a) default** (neither `--scale` nor `--output-height`) — fit within a 4K box (`TARGET_4K_LONG`=3840 × `TARGET_4K_SHORT`=2160, orientation-aware via long/short edges), rendering at the smallest integer ≥ the fit ratio and downscaling to the fitted size; **(b) `--scale N`** (`scaleExplicit`) — density: render at integer N, `outputHeight=null` (no downscale, can be any size incl. over-4K); **(c) `--output-height N`** — render at smallest integer ≥ N/height, downscale to N. **The default is the 4K-box fit, NOT a fixed scale 3** — this is deliberate (h2v stays generic about canvas; "4K default" is honest for any viewport). For 1280×720 the default is identical to the old ×3 behavior (3840×2160, no downscale); for 1920×1080 it's ×2 exact; for 1600×900 it renders ×3 and downscales. Load-bearing details: (1) the render scale is **always an integer** (crisp raster, no fractional-DSF aliasing) and we **only ever downscale, never upscale**; (2) `preparePage` uses `job.renderScale` (not `opts.scale`) for `deviceScaleFactor`, and `estimateWorkerMemoryMb` / the run summary use it too; (3) `ffmpegStitch` downscales via `scale=-2:job.outputHeight:flags=lanczos` (width auto-evened), **skipped** when `job.height * job.renderScale === job.outputHeight` (exact fit) and when `job.outputHeight == null` (density mode); (4) filter order in `ffmpegStitch` is **premultiply *then* scale** (scale alpha in premultiplied space to avoid edge halos), one `-vf` chain; (5) `--scale`/`--output-height` are mutually exclusive and `--output-height` must be even, both enforced in `resolveExportOpts`. Don't make `--scale` accept floats — fractional DSF aliasing is exactly what the integer-render-then-downscale path avoids. `DEFAULTS.scale` (3) is now only read when `scaleExplicit`.
- Duration precedence: explicit `--duration` flag > single-file `<meta name="h2v-duration">` > bundle marker's `capture_duration` > built-in default (`DEFAULTS.duration`). Explicit-ness is tracked via `opts.durationExplicit` in `parseArgs` so the built-in default doesn't masquerade as an override. When `--duration` is passed against a bundle, it overrides every marker's `capture_duration` for that run — that's intentional, not a bug.
- The review page's `</script>` escape (replacing `</` → `<\/` in the embedded JSON `ANIMATIONS = ...`). Without it, any animation containing a `</script>` tag breaks the outer page.
- Output paths: `output/<basename>.mp4` for single files, `output/<bundle>/<animation-id>.mp4` for bundles.
- The theme model: pages opt in via `<meta name="h2v-themes" content="...">` (single-file) or `themes="..."` on bundle markers. First declared theme = default = no `data-theme` attribute set, no filename suffix; non-default themes get `data-theme="<name>"` on `<html>` after navigation and a `-<name>` filename suffix. The CLI's `--theme <spec>` accepts a single name, a comma list, or `all`. Pages with no theme meta are single-theme. Theme names match `[a-zA-Z0-9_-]+`.
- The skip rules in directory mode: dotfiles and `review.html`. Directory listing is non-recursive, so subdirectories like `output/` or `node_modules/` aren't entered automatically. Explicitly named file args bypass these filters.
- The `data-h2v-recording` attribute on `<html>` and the injected `[data-h2v-hide]{display:none!important}` stylesheet, both applied after navigation in `recordJob`. Pages and the upcoming animation-creation skill rely on these names — renaming them is a breaking change. Only set during `export`, not during `review` (review is for human inspection, controls should stay visible).
- The parallel-job model: **one browser per worker**, never multiple pages in the same browser. `tests/bench-parallel.js` measured K=2 in mode A (two pages, one browser) at 0.13× of ideal — Chrome's screenshot pipeline serializes intra-process. Mode B (separate browsers) hits 3.42× of ideal at K=4. Don't "optimize" by sharing a browser across workers.
- The codec/container matrix in `ALLOWED_CONTAINERS_FOR_CODEC`: libx264/libx265 → mp4 or mov; libvpx-vp9 → webm only; prores_ks → mov only; gif → gif only. The defaults (`DEFAULT_CONTAINER_FOR_CODEC`) match what each codec is conventionally packaged in. Don't loosen these — vp9-in-mp4 was historically fragile across players, and prores-in-mp4 breaks every NLE we care about. `resolveExportOpts` validates and exits with a clear error on bad combos. The `-tag:v hvc1` we add for libx265 is required for QuickTime/Safari playback; harmless in `.mov`.
- GIF export (`--gif`, or `--codec gif`). Cross-cutting mode flag like `--alpha`: forces `codec=gif` + `container=gif` **before** the codec/container compatibility check in `resolveExportOpts` (same ordering reason as alpha), and applies GIF defaults — `DEFAULT_GIF_FPS` (20) and `DEFAULT_GIF_HEIGHT` (480, via `outputHeight`) — only when `--fps`/`--scale`/`--output-height` weren't given. **20fps is deliberate, not arbitrary**: GIF frame delays are quantized to centiseconds, and 20fps = exactly 5cs/frame; rates that don't divide 100 (e.g. 15) get rounded by the encoder and play off-speed. GIF is its own encode path in `ffmpegStitch` — a **single-pass `filter_complex`** (`split` → `palettegen` → `paletteuse`, plus the leading `scale` *inside* the graph since palettegen needs final resolution), `-loop 0`, no `buildEncodeArgs`/`-vf`/`+faststart`. Quality (palette + dither) is derived from `--quality-preset` in `buildGifFilterComplex` (max=per-frame palette+sierra; high=global+sierra; standard=global+bayer; draft=128+none) — there is intentionally **no `--gif-quality` flag**; reusing the preset matches how `buildEncodeArgs` derives per-codec choices from the tier. `diff_mode=rectangle` is always on. Mutually exclusive with `--alpha` (GIF has only 1-bit transparency) and with explicit `--codec`/`--container`. Don't add a `--gif-quality` flag or move the container/codec forcing after the matrix check.
- ProRes ignores `--crf` by design (it's a fixed-profile codec). `buildEncodeArgs` picks profile 4 + `yuv444p10le` + `-vendor apl0` at the `max` tier, otherwise profile 3 + `yuv422p10le`. Don't add `--crf` handling for prores_ks.
- The `--quality-preset` table in `QUALITY_PRESETS`: `max | high | standard | draft`. Each preset bundles `captureFormat`, `captureQuality`, `codec`, `crf`. Codec-specific encoder choices (pix_fmt, x264/x265 `-preset`, `-tune`, prores profile) are derived from `opts.qualityPreset` *inside* `buildEncodeArgs` — the preset table itself stays codec-agnostic. `resolveExportOpts` applies preset values only to fields the user didn't explicitly pass, gated by the `*Explicit` booleans on `opts`. Default is `standard`; passing no `--quality-preset` flag is identical to `--quality-preset standard`.
- `max` preset's `crf: 0` is intentionally set even though prores_ks ignores it. The reason: when a user combines `--quality-preset max --codec libx264`, the expected behavior is "max-tier encode with x264," which means lossless (CRF 0) yuv444p. Without the preset's `crf: 0`, the codec override would fall back to `DEFAULTS.crf` (18). Don't remove this.
- The `-tune animation` and `-movflags +faststart` always-on additions: `-tune animation` is appended for libx264/libx265 in every tier *except* `draft` (because `-preset ultrafast` disables most of what tune does anyway). `-movflags +faststart` is appended for any `mp4`/`mov` output regardless of codec or tier. These are pure wins for h2v's content type; they're not exposed as flags because there's no scenario where a user wants to turn them off.
- The `captureQualityExplicit` / `captureFormatExplicit` / `codecExplicit` / `crfExplicit` booleans on `opts` exist so `resolveExportOpts` can apply preset values only to fields the user didn't explicitly pass. They also let the "png + --capture-quality" mutex check fire only when `--capture-quality` was explicit (otherwise the standard preset's default of 95 would falsely trip the check whenever a user passed `--capture-format png`).
- The BEGIN/END marker pair in `docs/cli.md` (`<!-- BEGIN: auto-generated from \`h2v --help\` — do not edit by hand -->` and `<!-- END: auto-generated -->`) — `scripts/sync-help-docs.js` looks for these exact strings to find the auto-managed block. If you rename or reformat them, update both the doc and the script's `BEGIN_MARKER` / `END_MARKER` constants.
- The `--paste` flow's temp-file shape: `readPastedHtml()` returns a buffer, then `writePasteToTempFile()` writes it to a fresh `os.tmpdir()/h2v-paste-<random>/paste.html`. The fixed basename `paste` is **load-bearing** — it's what the existing `path.basename(inputPath, '.html')` derives so output paths land at `output/paste/<id>.<ext>` (bundles) or `output/paste.<ext>` (single-file). Don't refactor away the temp file in favor of streaming the buffer directly through the pipeline; the file path threads naturally through `discoverInputs` / `buildPlan` / `outputPathFor` and decoupling that would mean four functions need a "synthetic basename" parameter. Cleanup is registered via `process.on('exit')` the moment the temp dir is created, in **both** `main()` and `runReview()` — so it fires on every exit path, including the early `process.exit()` calls (no-match, `buildPlan`/`validatePlan` errors) and the `--dry-run` early return that happen before `main()`'s `try/finally`. (`main()`'s `finally` still handles the separate `capturesRoot`, which is created later, after those early exits.)
- The bracketed-paste markers in `readPastedHtml()` (`\x1b[200~` open, `\x1b[201~` close, exactly 6 bytes each) are an ANSI standard supported by every modern terminal — Terminal.app, iTerm2, gnome-terminal, Windows Terminal, VSCode terminal, etc. Don't reinvent. The fallback for terminals that don't support it (rare) is the Ctrl+D commit path.
- The asymmetric shim-injection in `recordJob` — `evaluateOnNewDocument` for single-file (`page.goto`) but `evaluate` for bundles (`page.setContent`) — looks redundant but is **load-bearing**. Puppeteer's `setContent` does `document.open(); document.write(html); document.close()` on the existing about:blank, which is NOT a navigation and does NOT fire `evaluateOnNewDocument`. Without `page.evaluate(SHIM)` first, the bundle's JS runs against an un-shimmed window and JS animations (`setTimeout`, `setInterval`, `performance.now`, `Date.now`, `requestAnimationFrame`) execute at full real-time speed — 6× too fast since the capture loop is paced to slowdown × frame interval. CSS keeps working because `Animation.setPlaybackRate` is a separate CDP call. This bug shipped silently for months until the demo's animation 09 (with a prominent JS-driven `~%` counter) made the JS-vs-CSS desync visible. Don't unify the two branches without re-running `tests/sync-test.html` to confirm both modes apply the shim. The same two-path asymmetry also carries the unconditional `window.__SCRUB__ = true` injection for the seek driver (see "The seek driver" section) — both the slowdown shim and the scrub flag ride the same `evaluate`-before-`setContent` / `evaluateOnNewDocument`-before-`goto` split.
- The seek driver and its `window.seek` detection (see "The seek driver" section above). The slowdown/play path is the universal fallback and must stay the default for non-cooperating pages — h2v's whole premise is rendering arbitrary HTML, so seek can only ever be an auto-detected fast path, never a requirement. Don't gate the feature behind a mandatory flag, don't make `__SCRUB__` conditional on detection, and don't remove the per-job driver log line (it's how a silent fallback is caught). Regression coverage: `npm run test:seek` (seek path) and `npm run test:sync` (play path) must both stay green.
- Frame-sharding and its warm-up replay (see the two "The seek driver" bullets on `recordJobSharded` and warm-up). The one-browser-per-shard rule is the same intra-process-serialization constraint as `runJobsParallel` — don't shard across pages in one browser. The warm-up prefix replay is mandatory for correctness on order-dependent `seek()` engines; `tests/seek-stateful-test.html` guards it. Single-*play* animations correctly do **not** shard.
- `requestAnimationFrame` is **intentionally not wrapped** in `SHIM_SOURCE`. Per the HTML5 spec, the timestamp passed to rAF callbacks is "the same value that performance.now() would return," and Chrome implements this by reading the (overridden) `performance.now` when constructing the timestamp argument. Our `Object.defineProperty` override of `performance.now` already makes rAF callbacks receive slowed timestamps for free. Wrapping rAF on top of that double-slows the timestamp by sf² (= 36× at default), which manifests as canvas/rAF-driven animations crawling along at 1/sf the expected rate (the user's line-graph animation reaching only ~25% by clip end was the canonical symptom). Don't add a wrapper around rAF; if you need to verify, run `tests/sync-test.html` — bar 6 ("requestAnimationFrame + timestamp arg") is the canary for this exact bug.
- `--alpha` couples four otherwise-independent options: it forces `opts.captureFormat === 'png'`, `opts.container === 'mov'`, constrains `opts.codec` to one of `{qtrle, png, prores_ks}` (default `qtrle`), and steps `opts.fps` down to `DEFAULTS.alphaFps` (30) when `--fps` wasn't passed explicitly. It also leaves `opts.alphaMode === 'premultiplied'` as the default (see the next invariant). `--alpha-mode` without `--alpha` is an error (the flag is meaningless on its own). The coupling lives in `resolveExportOpts` and runs *before* the codec/container compatibility check so the forced values participate in that validation. Don't move the check around without re-running `node cli.js export tests/bench-alpha-codec.fixture.html --alpha --dry-run` and the negative paths (`--alpha --codec libx264`, `--alpha --capture-format jpeg`, `--alpha --codec libvpx-vp9`, `--alpha-mode straight` without `--alpha`).
- `--alpha`'s default codec is `qtrle` (QuickTime Animation, RLE-lossless in MOV). The default has changed twice — read this whole entry before changing it again. **(1) Original default: `prores_ks`.** Demoted because ffmpeg's prores_ks muxer ships without an explicit `kCMFormatDescriptionExtension_AlphaChannelMode` tag, so players guess; QuickTime/FCP guessed straight (correct for our then-straight output), CapCut guessed pre-multiplied (wrong → bright halos on glows/semi-transparent fills). **(2) Second default: `png` (PNG-in-MOV) with pre-multiplied alpha.** Bit-exact lossless and ~6× smaller than ProRes 4444; fixed the short-clip CapCut test (1.5 s alpha fixture). Demoted after running `tests/bench-alpha-codec.sh` against `tests/bench-alpha-codec.fixture.html` (the real-world 4K 30 fps 16.8 s badges clip): CapCut's PNG-codec decoder failed alpha at full scale regardless of alpha mode — badge backgrounds rendered solid white. PNG-in-MOV still works for IINA, QuickTime Player, FCP, and web playback, so it remains opt-in via `--alpha --codec png`. **(3) Current default: `qtrle` + pre-multiplied alpha.** Passes the full-scale 4K 17s CapCut test plus QuickTime/FCP/Resolve/Premiere/AE. Lossless RLE, file size comparable to PNG-in-MOV. `prores_ks` remains opt-in for Apple colour-managed pipelines that demand 10-bit chroma. Don't switch the default back to `png` or `prores_ks` without re-running `tests/bench-alpha-codec.sh` against the bench fixture and verifying CapCut at full 4K + long duration.
- `--alpha` emits **pre-multiplied alpha** by default, not straight. This was empirically determined: testing 6 alpha-encoded variants in CapCut showed that pre-multiplied variants (qtrle, ProRes) rendered correctly 100% of the time, while straight-alpha variants rendered incorrectly (solid white badge backgrounds, blown-out semi-transparent regions). The root cause is that CapCut (and many other video-pipeline tools) default to assuming pre-multiplied alpha for compositing intermediates. The pre-multiplication is done via `-vf premultiply=inplace=1` in `ffmpegStitch` (NOT in `buildEncodeArgs` — the filter is independent of codec choice). The `-vf` arg is positioned between the input args and `buildEncodeArgs` output so it applies pre-encode, regardless of pix_fmt. Users who specifically need straight alpha opt in via `--alpha-mode straight`. Don't switch the default back to straight without re-running the CapCut variant test — it was definitive.
- The `qtrle` case in `buildEncodeArgs` is intentionally minimal: `-c:v qtrle` and `-pix_fmt argb` when alpha is on, `-pix_fmt rgb24` otherwise. `argb` is qtrle's native alpha layout (not `rgba`); ffmpeg silently re-orders other 32-bit input layouts. RLE-lossless; no quality knobs — `--crf` and `--quality-preset` are silently ignored. Don't add CRF/quality args to the case; qtrle codec doesn't accept them. The non-alpha branch exists for orthogonality but isn't a useful default for anything — opaque content should stay on libx264/libx265 for size reasons.
- The `png` case in `buildEncodeArgs` is intentionally minimal: `-c:v png` and `-pix_fmt rgba` when alpha is on, `-pix_fmt rgb24` otherwise. Both are bit-exact lossless. The PNG codec has no quality knobs — `--crf` and `--quality-preset` are silently ignored. Don't add a CRF arg to the case; PNG codec doesn't accept one. Note: PNG-in-MOV with alpha is verified-unreliable in CapCut at 4K + long durations; it's kept as a `--codec png` opt-in for non-CapCut workflows (see the alpha default-codec invariant for the full history).
- `--alpha`'s ProRes branch in `buildEncodeArgs` overrides profile and pix_fmt regardless of `--quality-preset` tier — alpha implies profile 4 (4444) + `yuva444p10le` because that's the only ProRes profile with an alpha plane. Don't gate this on `tier === 'max'` even though the non-alpha 4444 path does. The override is short-circuited at the top of the `prores_ks` case so the tier-aware logic below it stays untouched for non-alpha runs.
- `omitBackground: true` on `Page.captureScreenshot` is the load-bearing bit on the capture side for `--alpha` — it tells Chromium to skip painting its default white viewport, exposing the page's own paint (or transparency where the page paints nothing). It only works with `type: 'png'`; the JPEG branch in `recordJob` doesn't take an `omitBackground` option and JPEG can't carry alpha anyway. The pairing is enforced upstream in `resolveExportOpts`. If you ever add a third capture format, don't add an `omitBackground` knob to the JPEG branch — it's load-bearing-orthogonal.
- `libvpx-vp9` + `yuva420p` for WebM alpha — encoder advertises support but ffmpeg's wrapper silently drops the alpha plane in the simple invocation (verified empirically: output `pix_fmt=yuv420p`, round-tripped alpha is uniformly 255). Working VP9-with-alpha needs a multi-stream remux that's fragile across ffmpeg versions; deferred. Don't add `libvpx-vp9` to the `--alpha`-allowed codec set without re-verifying alpha actually round-trips through the produced `.webm`.
- The `require.main === module` guard at the bottom of `cli.js` is a **unit-test seam**: run directly (the `h2v` bin / `node cli.js`) it invokes `main()`; `require()`d (by `tests/test-unit.js`) it skips `main()` and exposes the pure, logic-dense functions via `module.exports` (`computeRenderPlan`, `splitFrameRanges`, `deriveThemes`, `buildEncodeArgs`, `buildGifFilterComplex`, `safeJsonForScript`, `extractViewport`, `parseBundleFrames`, `outputPathFor`, `driverLogLine`, `resolveExportOpts`). This keeps the single-file design while letting tests exercise the math in-process (no subprocess/Chromium). Don't add top-level side-effecting code outside the guard (it would run on `require`), and when adding a new pure helper worth testing, add it to the export list. `puppeteer` is `require`d lazily inside `main()` precisely so unit tests don't pull in Chromium.

## Review-page icons (how to add or change one)

The `h2v review` page (`buildReviewHtml` in `cli.js`) uses **inlined [Lucide](https://lucide.dev) SVG icons** — copied into the source, **not** an npm/font dependency. This is mandatory: the review page must stay a single self-contained HTML file with **zero external requests** (same constraint as the animations themselves). Never add an icon via a CDN `<link>`/`<script>`, a web font, or a runtime `fetch` — the icon must be inline SVG markup.

**To add a new icon:**

1. Find it at https://lucide.dev (prefer Lucide for visual consistency with the existing set). Copy the raw SVG. Keep its attributes: `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`, and add `aria-hidden="true"`. `stroke="currentColor"` is load-bearing — it makes the icon inherit the button's text color (incl. hover and light/dark `color-scheme`); don't hardcode a stroke color. `aria-hidden="true"` keeps the decorative glyph out of the accessibility tree — every icon button already has a visible text label and a `title`, so the icon must not be separately announced.
2. For card buttons (built in JS), define it as an `ICON_<NAME>` string constant next to `ICON_MAXIMIZE` / `ICON_EXTERNAL` and inject via `innerHTML`. For static-markup buttons (e.g. `#resetAll`), inline the `<svg>` directly in the HTML template string.
3. Sizing/alignment is already handled by `.card-btn svg` (13px) and `button.ctl svg` (14px) plus `inline-flex; gap` on the buttons — no per-icon CSS needed.
4. A different (non-Lucide) library is acceptable *if* it's similarly permissively licensed and you still inline the SVG — but matching Lucide keeps the chrome visually uniform.

**Icon placement convention** (don't "fix" the asymmetry — it's intentional): **leading** icon (before the label) for icons that describe the *action* (`maximize` → Full screen, `rotate-ccw` → Reset all); **trailing** icon (after the label) for icons that describe the *destination/consequence* (`external-link` → Actual size, because it opens in a new tab). This matches Material 3 / Apple HIG / Carbon / Polaris. New action icons lead; new-tab / direction / disclosure (chevron) icons trail.

Regression coverage: `tests/test-review.js` scenario 12 asserts the inlined Lucide path data and `stroke="currentColor"` — so swapping back to Unicode glyphs or breaking an icon fails `npm run test:review`.

## Operational notes

- The user typically generates animations at claude.ai (web), then runs `h2v export` locally. The expected workflow is short animations (5-30 seconds) processed one at a time or in small batches.
- A future user-mentioned direction is wrapping this in a Claude Agent SDK orchestrator so the whole prompt-to-video flow runs locally; not started yet.
- The repo is committed and pushed to a remote. Don't push without an explicit ask.
