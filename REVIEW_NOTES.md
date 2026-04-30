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
- `claudevid export` (no args) in a directory works as expected
- `--theme both` produces both dark and light variants correctly
- `<meta name="claudevid-duration">` is picked up from a single-file animation

## Items added during implementation

### Verified in sandbox (dry-run only, no browser)
- `claudevid --help` and `--version` print correctly
- `claudevid export --dry-run examples/swing-video/all-frames-bundle.html` lists 12 frames with correct durations and output paths
- Directory mode picks up `*.html` and skips dotfiles + `review.html`
- Explicitly named files bypass skip rules
- `--theme both` produces dark and light jobs with `-light` suffix
- `<meta name="claudevid-duration" content="3s">` is read and shown as "from meta tag" in plan
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
