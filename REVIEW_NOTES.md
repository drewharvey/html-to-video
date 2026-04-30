# Review Notes

Things to verify on your Mac that I couldn't verify in the sandbox. Delete this
file once you've worked through it.

## Sandbox limitations

This sandbox is aarch64 Linux. Google publishes no ARM64 Chrome and the
Ubuntu `chromium` package is a snap shim that doesn't run inside the
container. That means I can't run an actual recording end-to-end here.

What I *can* do here:
- Syntax check the code (`node --check`)
- Run dry-run mode (no browser launched)
- Run the existing `examples/swing-video/build-review.js` (no browser needed)

What needs your verification on macOS:
- Real recording produces correct 4K @ 60fps MP4s
- `h2v export` (no args) in a directory works as expected
- `--theme both` produces both dark and light variants correctly
- `<meta name="h2v-duration">` is picked up from a single-file animation

## Items added during implementation

### Verified in sandbox (dry-run only, no browser)
- `h2v --help` and `--version` print correctly
- `h2v export --dry-run examples/swing-video/all-frames-bundle.html` lists 12 frames with correct durations and output paths
- Directory mode picks up `*.html` and skips dotfiles + `review.html`
- Explicitly named files bypass skip rules
- `--theme both` produces dark and light jobs with `-light` suffix
- `<meta name="h2v-duration" content="3s">` is read and shown as "from meta tag" in plan
- `--duration` flag overrides default for files without meta
- `--out` is rejected when more than one MP4 would be produced
- `--out` accepted for single-job runs (path printed correctly)
- Bundle frame extraction returns intact `<!DOCTYPE html>...</html>` per frame
- Duplicate-output-path detection rejects collisions

### Needs verification on Mac (browser actually launches)
- A real bundle recording produces 12 MP4s in `output/all-frames-bundle/`
- A real single-file recording with a `<meta>` tag produces a correctly-timed MP4
- `--theme both` produces visually correct dark and light variants (theme override fires after page load)
- The `installClockOverride` function fires correctly when bundle frames are loaded via `page.setContent()` — this is the one piece of bundle-mode behavior I couldn't verify without a working browser. If something breaks here, the fallback is to write each frame to a temp file and use `goto file://...`.
- `captures/` directory cleanup runs on both success and failure paths
- ffmpeg availability check fires before the browser launches

### Installation check (one-time)
- From the project root: `npm install -g .` (or `npm link`) should put `h2v` on PATH. Verify with `which h2v` and `h2v --version`.

### Suggested first real run
```
cd examples/swing-video
h2v export all-frames-bundle.html
# Expect output/all-frames-bundle/frame-01.mp4 ... frame-12.mp4
# Compare against your previously-produced 4K MP4s — should be identical.
```

### CDP virtual time + beginFrame (frame-09 fix, second attempt)
The first attempt at this fix used only `Emulation.setVirtualTimePolicy`,
which turned out to virtualize the *timer* clock (Date, setTimeout, rAF)
but not the compositor's clock — so CSS transitions still ticked on
wall time, and frame-09 still desynced.

The current approach pairs `setVirtualTimePolicy` with
`HeadlessExperimental.beginFrame`. Each output frame:
  1. advances the timer clock by 1000/fps ms (fires JS timers), then
  2. calls beginFrame with a matching `frameTimeTicks`, which evaluates
     CSS animations/transitions at that virtual moment and renders +
     captures in one shot.

Three consequences for your environment:
- The recorder now launches `chrome-headless-shell` instead of the
  full Chrome (`headless: 'shell'`). `npm install puppeteer` already
  downloads chrome-headless-shell by default, so you shouldn't have to
  do anything. If launch fails with "Could not find chrome-headless-shell",
  run: `npx puppeteer browsers install chrome-headless-shell`.
- Chromium is launched with `--enable-begin-frame-control` and
  `--run-all-compositor-stages-before-draw`. These are mandatory for
  the new approach.
- Each page is opened via a raw `Target.createTarget` call with
  `enableBeginFrameControl: true`, not via `browser.newPage()`. The
  launch flag alone isn't enough; the per-target option is also
  required, otherwise `beginFrame` closes the target on its first
  call.

Things to watch for on your Mac:
- `frame-09.mp4` should now show the ring fill and the % counter
  finishing at the same moment (~2.5s after kick-off), matching the
  HTML when opened directly.
- Spot-check frames that use CSS transitions (frame-01 fade-in,
  frame-08 progress bar, frame-11 split layout) — they should look
  identical to the originals or subtly better.
- The screenshots are now produced by `HeadlessExperimental.beginFrame`
  (base64 PNG returned by CDP, written to disk by the script), not
  `page.screenshot()`. Pixel-identical visually but a different code
  path; if anything looks off in the output PNGs, that's the suspect.
- If a frame hangs, `Emulation.virtualTimeBudgetExpired` isn't firing.
  Likely cause: a runaway `setInterval` with delay 0 starving the
  budget. Bump `maxVirtualTimeTaskStarvationCount` in `cli.js`.
