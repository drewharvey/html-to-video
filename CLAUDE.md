# CLAUDE.md — h2v / html-to-video

A CLI (`h2v`) that records HTML animations as 4K MP4s via Puppeteer + ffmpeg. Entry point: `cli.js`. Designed for the workflow of generating animations at claude.ai and exporting them locally.

## Hard rules (load-bearing — read before changing anything in `cli.js`)

The animation-timing approach in `cli.js` is the result of many failed iterations. **Do not** "fix" or "improve" it without first re-reading the trade-off below.

1. **Don't try to pause Chromium's clocks.** Every variant of pausing — `Emulation.setVirtualTimePolicy({policy:'pause'})`, `Animation.setPlaybackRate(0)`, `anim.pause()` — eventually causes `Page.captureScreenshot` to hang because Chromium's compositor stops scheduling BeginFrames when there's nothing to render.
2. **Don't try `HeadlessExperimental.beginFrame` to drive frame-time.** It returns `Protocol error: BeginFrameControl is not supported on MacOS yet`. This is a hard Chromium limitation, not fixable from our side.
3. **Don't switch to `chrome-headless-shell` (`headless: 'shell'`).** Same macOS BeginFrame block applies, plus it adds a separate binary download dependency for nothing.
4. **Don't add Web Animations API micromanagement** (walking `document.getAnimations()`, `setCurrentTime`, `commitStyles`, `cancel`). All variants either don't reach the compositor's render or hang the screenshot pipeline as in (1).

The one approach that works on every platform Puppeteer supports: **slow everything by factor `S`** (default `10`, configurable via `--slowdown`).

## How animation timing actually works

`cli.js` synchronizes JS-driven and CSS-driven animations like this:

- **JS layer** (injected via `page.evaluateOnNewDocument` before any page script):
  - `setTimeout` / `setInterval` delays multiplied by `S`
  - `performance.now()` returns `(real-elapsed-since-load) / S`
  - `Date.now()` returns `loadEpoch + (real-elapsed-since-load) / S`
  - `requestAnimationFrame` callback timestamps scaled the same way
- **CSS layer** (CDP, after navigation): `Animation.setPlaybackRate({ playbackRate: 1 / S })`
- **Capture loop**: sleep `(1000 / fps) × S` ms between screenshots; encode the resulting PNGs at `fps`. Playback is at the original speed.

Wall time per recording = animation duration × S. With S=10, a 5-second animation takes ~50 seconds. Tunable via `--slowdown`.

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

`/tmp/h2v-test/sync-test.html` is a 1-second, low-resolution fixture with two parallel bars:
- Top: CSS `transition: width 1s linear`
- Bottom: JS `setInterval` writing `width = X%`

If they fill in lockstep, synchronization is working. Inspect output PNGs by `Read`-ing them — Claude Code reads images.

Quick run:
```
cd /tmp/h2v-test
node /Users/drewharvey/Projects/claude-animation-app/cli.js export sync-test.html \
  --no-ffmpeg --width 480 --height 200 --scale 1
```
Then `Read /tmp/h2v-test/captures/sync-test/0015.png` for the midpoint frame; both bars should read ~25% (frame 15 of 60 = 25% of a 1s animation).

## Codebase shape

```
cli.js                          # ~700 lines, one file, only dep is puppeteer
package.json                    # bin: { h2v, html-to-video } → cli.js
README.md                       # user-facing docs
examples/swing-video/           # worked example: 12-frame storyboard bundle
  all-frames-bundle.html        # source bundle with FRAME_START markers
  frames/                       # split bundle (committed for convenience)
  build-review.js               # generates review.html for local browser preview
  README.md
.gitignore                      # node_modules, output, captures, review.html, .DS_Store
```

## Things that aren't broken — don't change them

- The bundle marker format (`<!-- ===== FRAME_START id="..." capture_duration="Ns" ===== -->`) — extra attributes like `filename` are tolerated and ignored.
- The single-file metadata convention (`<meta name="h2v-duration" content="Ns">`).
- Output paths: `output/<basename>.mp4` for single files, `output/<bundle>/<frame-id>.mp4` for bundles.
- The `--theme dark|light|both` flag and `-light` filename suffix convention.
- The skip rules in directory mode (dotfiles, `review.html`, anything inside `output/` / `node_modules/` / `frames/`). Explicitly named file args bypass them.

## Operational notes

- The user typically generates animations at claude.ai (web), then runs `h2v export` locally. The expected workflow is short animations (5-30 seconds) processed one at a time or in small batches.
- A future user-mentioned direction is wrapping this in a Claude Agent SDK orchestrator so the whole prompt-to-video flow runs locally; not started yet.
- The repo is committed and pushed to a remote. Don't push without an explicit ask.
