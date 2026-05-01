# CLAUDE.md — h2v / html-to-video

A CLI (`h2v`) with two subcommands:
- `h2v export` — records HTML animations as 4K MP4s via Puppeteer + ffmpeg.
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
package.json                    # bin: { h2v, html-to-video } → cli.js
README.md                       # user-facing docs
demo/                           # smoke-test fixtures for the three usage modes
  bundle.html                   # 12-animation bundle with ANIMATION_START markers
  animations/                   # the same 12 animations as standalone files
                                # (each with <meta name="h2v-duration">)
  README.md
.gitignore                      # node_modules, output, captures, review.html, .DS_Store
```

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

## Operational notes

- The user typically generates animations at claude.ai (web), then runs `h2v export` locally. The expected workflow is short animations (5-30 seconds) processed one at a time or in small batches.
- A future user-mentioned direction is wrapping this in a Claude Agent SDK orchestrator so the whole prompt-to-video flow runs locally; not started yet.
- The repo is committed and pushed to a remote. Don't push without an explicit ask.
