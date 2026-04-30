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

(populated as work progresses)
