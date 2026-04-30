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

At the default `--slowdown 10` this takes about 15 seconds of wall time. Inspect the output:

```
ffmpeg -y -i output/sync-test.mp4 -ss 0.5 -frames:v 1 mid.png
ffmpeg -y -i output/sync-test.mp4 -ss 1.0 -frames:v 1 late.png
```

- **mid.png** (0.5 s in): both bars should be at ~50 % and visually the same length.
- **late.png** (1.0 s in): both bars at 100 %. The remaining 0.5 s of the clip is "settled" and confirms the animation completed.

If the green and blue bars are different widths at the same moment, the recorder broke.
