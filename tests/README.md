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

## alpha-test.html

A 1.5-second fixture for verifying that `h2v export --alpha` produces a video with a real per-pixel alpha channel. Pink "alpha" text fades in over a transparent body. Use this fixture (not `sync-test.html`) when validating the alpha pipeline — `sync-test.html`'s body has no explicit transparency rule so corner pixels can pick up Chromium defaults.

### Usage

```
h2v export tests/alpha-test.html --alpha --width 640 --height 360 --scale 1
```

Verify the output has alpha:

```
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,pix_fmt -of default=nw=1 output/alpha-test.mov
```

Expect `codec_name=png`, `pix_fmt=rgba` (PNG-in-MOV, the `--alpha` default). For the ProRes 4444 opt-in (`--alpha --codec prores_ks`), expect `codec_name=prores`, `pix_fmt=yuva444p12le` instead.

To assert pixel-level transparency, extract a mid-clip frame as 8-bit RGBA and sample the alpha plane:

```
ffmpeg -y -i output/alpha-test.mov -ss 0.7 -frames:v 1 -pix_fmt rgba -update 1 mid.png
ffmpeg -i mid.png -filter_complex "extractplanes=a" -frames:v 1 -f rawvideo - | \
  python3 -c "import sys; b=sys.stdin.buffer.read(); print(f'min={min(b)} max={max(b)} transparent={sum(1 for x in b if x==0)}/{len(b)}')"
```

Expect `min=0` (transparent regions exist) and a non-trivial transparent-pixel count (the area around the text). At t=0.7 s the text is mid-fade, so `max` will be partial (~150–200, not 255).

If the alpha plane is uniformly 255 anywhere a transparent region should exist, either the page is painting an opaque background or `omitBackground` isn't being passed through to the screenshot.

## bench-screenshot.js

Benchmarks puppeteer screenshot speed at 4K across image formats (PNG, JPEG, WebP) and option combinations (`optimizeForSpeed`, `captureBeyondViewport`). Useful when revisiting the capture-format choice or checking a different host's screenshot p95 (which is what bounds how low `--slowdown` can safely go).

```
node tests/bench-screenshot.js
```

The fixture loads `sync-test.html`. 30 captures per config; reports mean / p50 / p95 ms and average bytes per frame.

## bench-quality.js

Captures the same settled frame as PNG, JPEG q=95, and JPEG q=85 to `/tmp/quality.*`. Use for a side-by-side or for PSNR with `ffmpeg -lavfi psnr`. Defaults to the sync-test fixture; pass another HTML path as `argv[2]` to test richer content (e.g. `node tests/bench-quality.js demo/animations/01-established-app.html`).

JPEG q=95 measured at PSNR ≈ 58 dB across the sync-test fixture and the demo animations — well above the 40 dB "visually lossless" threshold and far smaller than what the downstream x264 CRF 18 step contributes.

## bench-parallel.js

Tests whether screenshots parallelize. Runs K back-to-back screenshot loops at 4K under two modes:

- **Mode A** — K pages in one browser process
- **Mode B** — K browsers, one page each

```
node tests/bench-parallel.js          # both modes
node tests/bench-parallel.js A        # only mode A
node tests/bench-parallel.js B        # only mode B
```

Result on this codebase (sandbox ARM Linux Chromium, K ∈ {1, 2, 4}): Mode A is catastrophic — K=2 made each capture ~16× slower (per-shot 78 ms → 1399 ms). Mode B is near-linear: K=4 hits 3.42× of ideal (≈85% efficiency). That's why the `--concurrency` implementation in `cli.js` uses one browser per worker, never multiple pages in one browser. If you change that, re-run this benchmark first.

## bench-alpha-codec.sh

Compares every alpha-capable codec against the same set of captured frames. Run this whenever you're considering a change to the `--alpha` default codec — it produces the input data the call needs.

```
./tests/bench-alpha-codec.sh                       # default fixture
./tests/bench-alpha-codec.sh path/to/clip.html     # custom HTML
pbpaste | ./tests/bench-alpha-codec.sh --paste     # paste HTML from clipboard
```

How it works:

1. Captures frames once via `node cli.js export ... --alpha --no-ffmpeg`, forcing duration to `BENCH_DURATION_SECS` (default `20` — matches/exceeds the 4K 30 fps 17 s real-world failure-mode profile). Override the duration with `BENCH_DURATION_SECS=30 ./tests/bench-alpha-codec.sh`.
2. Re-encodes those exact frames seven ways (qtrle pre-mult / qtrle straight / PNG pre-mult / PNG straight / ProRes 4444 pre-mult / ProRes 4444 straight / HEVC-VT on macOS), saving each to `output/alpha-bench/`.
3. Prints a size summary so you can spot egregious outliers.

Default fixture is `tests/bench-alpha-codec.fixture.html` — the real-world badges animation that revealed CapCut's PNG-decoder failure at 4K + long durations. That failure is the reason qtrle is the current `--alpha` default (see the alpha invariants in `CLAUDE.md`); future codec-default discussions need a reproducible reference, and this fixture is it.

How to use the output: drag each `.mov` onto your NLE timeline. For each variant, verify (a) it imports without an "interpret footage" dialog, (b) the alpha channel is auto-detected, (c) it renders visually correct. Rename or restart the NLE between imports to defeat decoder caching, which can give false positives.

Approx run time: capture step dominates. At default `BENCH_DURATION_SECS=20`, slowdown 6×, 4K → ~120 s wall time for the capture, plus a few seconds for each of the seven encodes.
