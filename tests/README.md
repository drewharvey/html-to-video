# Tests

Two-layer test suite plus standalone benchmarks. The fixtures (HTML files) double as inputs to manual exploration and to the automated tests below.

| Layer | Run | When | Wall time | Notes |
|---|---|---|---|---|
| **Fast** | `npm test` | Every push + PR via `.github/workflows/tests.yml` | ~10s | No Chromium / ffmpeg. CLI-surface tests only (`--dry-run` for export, `--no-open` for review, file I/O for bundle). |
| **E2E** | `npm run test:e2e` | Every push + PR via `.github/workflows/tests-e2e.yml` | ~2 min | Real exports. Needs Puppeteer's Chrome + ffmpeg/ffprobe. |
| Benchmarks | `node tests/bench-*.js` | On demand only | Varies | Perf characterization, not pass/fail. |

## Fast-layer tests

### test-bundle.js (`npm run test:bundle`)

Correctness tests for `h2v bundle` — assembling standalone HTML files into a single bundle. 8 scenarios covering metadata extraction, decompose-and-merge, duplicate-id error paths, default output-path derivation. Round-trip property: `h2v bundle demo/animations/` produces a bundle equivalent to the committed `demo/bundle.html`.

### test-plan.js (`npm run test:plan`)

Pre-browser pipeline tests via `h2v export --dry-run`. ~25 scenarios covering:
- **Metadata extraction** — `<meta name="h2v-*">` tags reach the plan
- **Bundle decomposition** — every `ANIMATION_START` becomes a plan row
- **Skip rules** — dotfiles + `review.html` excluded from directory mode
- **Flag overrides** — `--duration`, `--width`+`--height` (coupled pair), `--theme`, `--fps`
- **Quality preset matrix** — max / high / standard / draft
- **Alpha coupling** — `--alpha` forces `.mov`, fps 30, allowed codec set `{qtrle, png, prores_ks}`
- **Error paths** — incompatible flag combos exit 2 with specific messages

### test-review.js (`npm run test:review`)

Tests `h2v review --no-open` HTML generation. 7 scenarios:
- Animation count + IDs per input
- Per-file viewport meta reflected in iframe sizing
- `</script>` escape canary (a fixture containing literal `</script>` must not break the outer page)

## E2E tests (real exports)

These exercise the full pipeline — Puppeteer → screenshots → ffmpeg → output file → `ffprobe` assertions. Each scenario writes a short low-resolution video to a temp dir and inspects it.

### test-export-flags.js (`npm run test:export-flags`)

Per-flag e2e validation. 16 scenarios, one per user-facing flag (or coupled set):
- **Timing / dimensions** — `--duration`, `--fps`, `--width`+`--height`+`--scale`
- **Codec / container** — `--codec libx265`, `--container mov` paired with `--codec libx264`
- **Quality preset** — `max` (ProRes 4:4:4 path), `draft` (h264)
- **Quality knob** — `--crf 0` vs `--crf 28` size differ
- **Capture-side** — `--capture-format png`, `--capture-quality 10` vs 95 size differ, `--no-ffmpeg`
- **File placement** — `--out`, `--out-dir`, `--theme dark,light` (multi-output)
- **Concurrency** — `--concurrency 2` on a 4-anim bundle produces 4 valid outputs

For each flag the assertion is "the flag took effect on the output" — ffprobe sees the right codec, file lands at the expected path, etc. Not a Cartesian product across combinations.

### test-sync.js (`npm run test:sync`)

The canonical sync invariant. Exports `tests/sync-test.html` at the default `--slowdown 6` and verifies all **six animation time sources** fill in lockstep:

1. CSS transition (Animation domain)
2. CSS @keyframes (Animation domain)
3. Web Animations API (Animation domain)
4. setInterval + performance.now()
5. setInterval + Date.now()
6. requestAnimationFrame + timestamp arg

At video t=0.5s each bar must be at ~50% width; at t=1.0s each must be fully filled. The test samples pixels at 25%, 50%, 75% of each track and asserts presence/absence of bar color. Catches shim wrapping bugs (e.g. the historical rAF double-slow), `Animation.setPlaybackRate` disconnect, and capture-loop drift.

### test-alpha-e2e.js (`npm run test:alpha-e2e`)

End-to-end validation of `--alpha`. 5 scenarios:
- **Default `--alpha`** — qtrle codec, argb pix_fmt, .mov container, fps 30
- **Real transparency** — at fixture t=0, alpha plane is near-zero; at t=1.0 text glyphs are opaque
- **`--codec prores_ks`** — prores stream with `yuva444p<N>le` (alpha-capable 4:4:4)
- **`--codec png`** — png-in-MOV with `rgba`
- **`--alpha-mode straight` vs pre-mult (default)** — pixel-level: median R/α ratio in straight output exceeds pre-mult's by a clear margin

## Fixtures

### sync-test.html

A 1.5-second fixture with six parallel bars, each driven by a different JS/CSS time source (CSS transition, CSS @keyframes, Web Animations API, setInterval+performance.now, setInterval+Date.now, requestAnimationFrame+timestamp arg). The canonical regression test for the recorder's timing approach — consumed by `test-sync.js` automated and by manual export when debugging timing issues.

Manual run (low-res, ~9 s wall time at default `--slowdown 6`):

```
h2v export tests/sync-test.html --width 640 --height 360 --scale 1
ffmpeg -y -i output/sync-test.mp4 -ss 0.5 -frames:v 1 mid.png
ffmpeg -y -i output/sync-test.mp4 -ss 1.0 -frames:v 1 late.png
```

- **mid.png** (0.5 s in): all six bars at ~50%, visually identical lengths.
- **late.png** (1.0 s in): all six at 100%. The remaining 0.5 s of the clip is "settled."

### alpha-test.html

A 1.5-second fixture verifying that `h2v export --alpha` produces a video with a real per-pixel alpha channel. Pink "alpha" text fades in over a transparent body. Use this (not `sync-test.html`) when validating the alpha pipeline — `sync-test.html`'s body has no explicit transparency rule so corner pixels can pick up Chromium defaults.

Manual export + alpha sanity check:

```
h2v export tests/alpha-test.html --alpha --width 640 --height 360 --scale 1
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,pix_fmt -of default=nw=1 output/alpha-test.mov
```

Expect `codec_name=qtrle`, `pix_fmt=argb` (qtrle, the `--alpha` default).

### bench-alpha-codec.fixture.html

Real-world badges animation used by `bench-alpha-codec.sh` (see below). Exhibited the CapCut white-background bug that prompted the switch from PNG-in-MOV to qtrle as the `--alpha` default.

## Benchmarks (not pass/fail)

### bench-screenshot.js

Benchmarks puppeteer screenshot speed at 4K across image formats (PNG, JPEG, WebP) and option combinations (`optimizeForSpeed`, `captureBeyondViewport`). Useful when revisiting the capture-format choice or checking a different host's screenshot p95 (which is what bounds how low `--slowdown` can safely go).

```
node tests/bench-screenshot.js
```

The fixture loads `sync-test.html`. 30 captures per config; reports mean / p50 / p95 ms and average bytes per frame.

### bench-quality.js

Captures the same settled frame as PNG, JPEG q=95, and JPEG q=85 to `/tmp/quality.*`. Use for a side-by-side or for PSNR with `ffmpeg -lavfi psnr`. Defaults to the sync-test fixture; pass another HTML path as `argv[2]` to test richer content (e.g. `node tests/bench-quality.js demo/animations/01-established-app.html`).

JPEG q=95 measured at PSNR ≈ 58 dB across the sync-test fixture and the demo animations — well above the 40 dB "visually lossless" threshold and far smaller than what the downstream x264 CRF 18 step contributes.

### bench-parallel.js

Tests whether screenshots parallelize. Runs K back-to-back screenshot loops at 4K under two modes:

- **Mode A** — K pages in one browser process
- **Mode B** — K browsers, one page each

```
node tests/bench-parallel.js          # both modes
node tests/bench-parallel.js A        # only mode A
node tests/bench-parallel.js B        # only mode B
```

Result on this codebase (sandbox ARM Linux Chromium, K ∈ {1, 2, 4}): Mode A is catastrophic — K=2 made each capture ~16× slower (per-shot 78 ms → 1399 ms). Mode B is near-linear: K=4 hits 3.42× of ideal (≈85% efficiency). That's why the `--concurrency` implementation in `cli.js` uses one browser per worker, never multiple pages in one browser. If you change that, re-run this benchmark first.

### bench-alpha-codec.sh

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
