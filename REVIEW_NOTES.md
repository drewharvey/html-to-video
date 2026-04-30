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

### CSS-vs-JS clock fix (frame-09), final working approach
Four earlier attempts didn't pan out:
1. `Emulation.setVirtualTimePolicy` alone — virtualizes JS timers but
   not the compositor; CSS transitions still ticked on wall time.
2. Adding `HeadlessExperimental.beginFrame` to drive the compositor —
   blocked by Chromium: `BeginFrameControl is not supported on MacOS yet`.
3. Walking `document.getAnimations()` and `setCurrentTime` only — JS
   reported the right state but Chromium rendered the compositor's
   real-time-advanced state.
4. Adding `anim.pause()` to freeze the rendered state — broke
   `Page.captureScreenshot` because the compositor stopped scheduling
   BeginFrames when it had nothing to render.

Working approach: instead of trying to pause Chromium's clocks, **slow
everything by a factor `S`** (default 10) and capture at slowed wall
time. JS shim multiplies `setTimeout`/`setInterval`/`Date.now`/
`performance.now`/rAF-timestamp by 1/S. CDP `Animation.setPlaybackRate(1/S)`
slows CSS animations and transitions. Capture loop sleeps
`(1000/fps) × S` ms between screenshots. The output MP4 encoded at the
target fps plays back at the original speed.

Verified in sandbox by recording a custom sync-test fixture with two
parallel bars (one CSS transition, one JS setInterval) — both reach
50% at frame 30 of 60 and 100% at frame 60. Also recorded
`frame-09-automation.html`: ring fill and `~%` counter advance in
lockstep through the entire animation.

Trade-off: recording wall time = animation × S. With S=10, a 5-second
animation takes 50 seconds. The user can lower `--slowdown` if their
machine handles screenshots fast enough.

Things to watch for on your Mac:
- `frame-09.mp4` should now show the ring fill and the % counter
  finishing at the same moment (~2.5s after kick-off), matching the
  HTML when opened directly.
- Spot-check frames that use CSS transitions (frame-01 fade-in,
  frame-08 progress bar, frame-11 split layout) — they should look
  identical to the originals or subtly better.
- Default headless mode (`headless: true`) is back; no chrome-headless-shell
  download or special flags required.
- One known limitation: SMIL animations (`<animate>` inside SVG)
  aren't reachable through `document.getAnimations()`, so they'd
  still tick on wall time. None of the Swing frames use SMIL, but
  flag this if future animations do.
- If a frame hangs, `Emulation.virtualTimeBudgetExpired` isn't firing.
  Likely cause: a runaway `setInterval` with delay 0 starving the
  budget. Bump `maxVirtualTimeTaskStarvationCount` in `cli.js`.
