# Tests

Fixtures for verifying that `h2v` records animations correctly. Not part of the demo (no marketing content here) — these exist to make iterating on the recorder fast and to catch regressions.

## sync-test.html

A 1.5-second fixture with two parallel bars:

- 🟢 **CSS** — `transition: width 1s linear` from 0 % to 100 %
- 🔵 **JS** — `setInterval` writing `width = X %` driven by `performance.now()`

If the recorder is keeping JS-driven and CSS-driven time in lockstep, the two bars fill at the same rate. If the green bar finishes earlier than the blue, that's the symptom of the timing desync that the slowdown approach in `cli.js` exists to prevent.

### Usage

```
h2v export tests/sync-test.html --width 640 --height 360 --scale 1
```

At the default `--slowdown 6` this takes about 9 seconds of wall time. Inspect the output:

```
ffmpeg -y -i output/sync-test.mp4 -ss 0.5 -frames:v 1 mid.png
ffmpeg -y -i output/sync-test.mp4 -ss 1.0 -frames:v 1 late.png
```

- **mid.png** (0.5 s in): both bars should be at ~50 % and visually the same length.
- **late.png** (1.0 s in): both bars at 100 %. The remaining 0.5 s of the clip is "settled" and confirms the animation completed.

If the green and blue bars are different widths at the same moment, the recorder broke.

## bench-screenshot.js

Benchmarks puppeteer screenshot speed at 4K across image formats (PNG, JPEG, WebP) and option combinations (`optimizeForSpeed`, `captureBeyondViewport`). Useful when revisiting the capture-format choice or checking a different host's screenshot p95 (which is what bounds how low `--slowdown` can safely go).

```
node tests/bench-screenshot.js
```

The fixture loads `sync-test.html`. 30 captures per config; reports mean / p50 / p95 ms and average bytes per frame.

## bench-quality.js

Captures the same settled frame as PNG, JPEG q=95, and JPEG q=85 to `/tmp/quality.*`. Use for a side-by-side or for PSNR with `ffmpeg -lavfi psnr`. Defaults to the sync-test fixture; pass another HTML path as `argv[2]` to test richer content (e.g. `node tests/bench-quality.js demo/animations/01-established-app.html`).

JPEG q=95 measured at PSNR ≈ 58 dB across the sync-test fixture and the demo animations — well above the 40 dB "visually lossless" threshold and far smaller than what the downstream x264 CRF 18 step contributes.
