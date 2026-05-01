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
- Duration precedence: explicit `--duration` flag > single-file `<meta name="h2v-duration">` > bundle marker's `capture_duration` > built-in default (`DEFAULTS.duration`). Explicit-ness is tracked via `opts.durationExplicit` in `parseArgs` so the built-in default doesn't masquerade as an override. When `--duration` is passed against a bundle, it overrides every marker's `capture_duration` for that run — that's intentional, not a bug.
- The review page's `</script>` escape (replacing `</` → `<\/` in the embedded JSON `ANIMATIONS = ...`). Without it, any animation containing a `</script>` tag breaks the outer page.
- Output paths: `output/<basename>.mp4` for single files, `output/<bundle>/<animation-id>.mp4` for bundles.
- The theme model: pages opt in via `<meta name="h2v-themes" content="...">` (single-file) or `themes="..."` on bundle markers. First declared theme = default = no `data-theme` attribute set, no filename suffix; non-default themes get `data-theme="<name>"` on `<html>` after navigation and a `-<name>` filename suffix. The CLI's `--theme <spec>` accepts a single name, a comma list, or `all`. Pages with no theme meta are single-theme. Theme names match `[a-zA-Z0-9_-]+`.
- The skip rules in directory mode: dotfiles and `review.html`. Directory listing is non-recursive, so subdirectories like `output/` or `node_modules/` aren't entered automatically. Explicitly named file args bypass these filters.
- The `data-h2v-recording` attribute on `<html>` and the injected `[data-h2v-hide]{display:none!important}` stylesheet, both applied after navigation in `recordJob`. Pages and the upcoming animation-creation skill rely on these names — renaming them is a breaking change. Only set during `export`, not during `review` (review is for human inspection, controls should stay visible).
- The parallel-job model: **one browser per worker**, never multiple pages in the same browser. `tests/bench-parallel.js` measured K=2 in mode A (two pages, one browser) at 0.13× of ideal — Chrome's screenshot pipeline serializes intra-process. Mode B (separate browsers) hits 3.42× of ideal at K=4. Don't "optimize" by sharing a browser across workers.
- The codec/container matrix in `ALLOWED_CONTAINERS_FOR_CODEC`: libx264/libx265 → mp4 or mov; libvpx-vp9 → webm only; prores_ks → mov only. The defaults (`DEFAULT_CONTAINER_FOR_CODEC`) match what each codec is conventionally packaged in. Don't loosen these — vp9-in-mp4 was historically fragile across players, and prores-in-mp4 breaks every NLE we care about. `resolveExportOpts` validates and exits with a clear error on bad combos. The `-tag:v hvc1` we add for libx265 is required for QuickTime/Safari playback; harmless in `.mov`.
- ProRes ignores `--crf` by design (it's a fixed-profile codec). `buildEncodeArgs` picks profile 4 + `yuv444p10le` + `-vendor apl0` at the `max` tier, otherwise profile 3 + `yuv422p10le`. Don't add `--crf` handling for prores_ks.
- The `--quality-preset` table in `QUALITY_PRESETS`: `max | high | standard | draft`. Each preset bundles `captureFormat`, `captureQuality`, `codec`, `crf`. Codec-specific encoder choices (pix_fmt, x264/x265 `-preset`, `-tune`, prores profile) are derived from `opts.qualityPreset` *inside* `buildEncodeArgs` — the preset table itself stays codec-agnostic. `resolveExportOpts` applies preset values only to fields the user didn't explicitly pass, gated by the `*Explicit` booleans on `opts`. Default is `standard`; passing no `--quality-preset` flag is identical to `--quality-preset standard`.
- `max` preset's `crf: 0` is intentionally set even though prores_ks ignores it. The reason: when a user combines `--quality-preset max --codec libx264`, the expected behavior is "max-tier encode with x264," which means lossless (CRF 0) yuv444p. Without the preset's `crf: 0`, the codec override would fall back to `DEFAULTS.crf` (18). Don't remove this.
- The `-tune animation` and `-movflags +faststart` always-on additions: `-tune animation` is appended for libx264/libx265 in every tier *except* `draft` (because `-preset ultrafast` disables most of what tune does anyway). `-movflags +faststart` is appended for any `mp4`/`mov` output regardless of codec or tier. These are pure wins for h2v's content type; they're not exposed as flags because there's no scenario where a user wants to turn them off.
- The `captureQualityExplicit` / `captureFormatExplicit` / `codecExplicit` / `crfExplicit` booleans on `opts` exist so `resolveExportOpts` can apply preset values only to fields the user didn't explicitly pass. They also let the "png + --capture-quality" mutex check fire only when `--capture-quality` was explicit (otherwise the standard preset's default of 95 would falsely trip the check whenever a user passed `--capture-format png`).
- The BEGIN/END marker pair in `docs/cli.md` (`<!-- BEGIN: auto-generated from \`h2v --help\` — do not edit by hand -->` and `<!-- END: auto-generated -->`) — `scripts/sync-help-docs.js` looks for these exact strings to find the auto-managed block. If you rename or reformat them, update both the doc and the script's `BEGIN_MARKER` / `END_MARKER` constants.

## Operational notes

- The user typically generates animations at claude.ai (web), then runs `h2v export` locally. The expected workflow is short animations (5-30 seconds) processed one at a time or in small batches.
- A future user-mentioned direction is wrapping this in a Claude Agent SDK orchestrator so the whole prompt-to-video flow runs locally; not started yet.
- The repo is committed and pushed to a remote. Don't push without an explicit ask.
