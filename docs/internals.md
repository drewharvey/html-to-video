# How recording actually works

A guide to h2v's recording mechanism for contributors and anyone curious about why the code does what it does. Operator-side flags are documented in [`cli.md`](cli.md); HTML-side authoring conventions are in [`authoring.md`](authoring.md).

For the full list of "things that aren't broken — don't change them" and the failed approaches that motivated the current design, see [`../CLAUDE.md`](../CLAUDE.md). That file is load-bearing context for anyone modifying `cli.js`.

---

## The core problem

Capturing N frames per second of a real-time animation by taking N screenshots per second doesn't work. Headless Chrome's `Page.captureScreenshot` takes ~80–150 ms at 4K — well over a 60 fps frame interval (~16.6 ms). At real-time speed, every screenshot misses several intended frames.

The obvious fixes — pause the page's clocks, drive the compositor frame-by-frame — all turn out to have hard blockers on at least one platform we need to support. See `../CLAUDE.md` for the full failed-approaches table; they include `Emulation.setVirtualTimePolicy`, `HeadlessExperimental.beginFrame`, `Animation.setPlaybackRate(0)`, and Web Animations API micromanagement. Each one either breaks the screenshot pipeline (no BeginFrame → captureScreenshot hangs) or hits the macOS-specific `BeginFrameControl is not supported on MacOS yet` error.

The approach that works on every Puppeteer-supported platform: **slow everything in the page by a factor `S`** (default 6, `--slowdown <N>`).

---

## The slowdown trick

`cli.js` synchronizes JS-driven and CSS-driven animations like this:

### JS layer — injected before any page script runs

`page.evaluateOnNewDocument` registers a tiny shim that wraps every JS-side time source:

- `setTimeout` / `setInterval` delays multiplied by `S`
- `performance.now()` returns `(real-elapsed-since-load) / S`
- `Date.now()` returns `loadEpoch + (real-elapsed-since-load) / S`
- `requestAnimationFrame` callback timestamps scaled the same way

All four wrap the originals; nothing is replaced wholesale. Page scripts that ask "what time is it?" or "schedule X in Y ms" see a slowed-down clock.

### CSS layer — applied after navigation

The CDP Animation domain has a knob for this:

```js
await client.send('Animation.setPlaybackRate', { playbackRate: 1 / S });
```

This slows every CSS animation, transition, and Web Animations API entry on the page by the same factor.

### Capture loop

```
sleep (1000 / fps) × S ms between screenshots
encode the resulting frames at fps
```

Each captured frame lands at the correct *moment* of the original animation; the encoded video plays back at the original speed. Wall time per recording = animation duration × S.

That's the entirety of the recording strategy — `recordJob` in `cli.js` is short. If you need to change it, do so with full awareness of the failed-approaches table in `CLAUDE.md`.

### Trade-off

Total recording wall time = animation duration × S. With S = 6, a 5-second animation takes ~30 seconds. Tunable via `--slowdown`:

- **Raise** on slow machines if you see CSS/JS desync (e.g. a CSS transition finishing before its JS counterpart).
- **Lower** if screenshots have headroom (the per-tick budget is `(1000 / fps) × S` ms; at 60 fps with S = 6 that's ~100 ms, well above the ~80 ms screenshot p95).
- `--slowdown 1` disables the trick entirely. Only viable if a screenshot fits in one frame interval (~16 ms at 60 fps), which it usually doesn't at 4K.

### Caveat

The shim doesn't slow Workers, WebSockets, or `fetch` — none of which are typical in the short, self-contained animations h2v is built for, but worth knowing if you use them.

---

## Frame capture format

Frames are captured as **JPEG q=95** (configurable via `--capture-format` and `--capture-quality`) rather than PNG.

JPEG q=95 is visually lossless against the downstream x264 step (PSNR ≈ 58 dB on the sync-test fixture and the demo animations) and ~30% faster to encode at 4K. The downstream x264 CRF 18 step dominates the perceptual quality of the final video anyway — there's no point in handing it bit-exact PNGs only to throw the precision away in lossy encoding.

PNG is available via `--capture-format png` for archival workflows or when the captures themselves are the deliverable (e.g. `--no-ffmpeg` for downstream tooling). The `max` quality preset uses PNG capture for this reason.

---

## Parallel job model

`--concurrency K` runs K independent worker pools, each pulling jobs from a shared queue. Each worker has **its own browser process** — never multiple pages in the same browser.

`tests/bench-parallel.js` measured the difference. With K=2:

| Mode | Setup | Throughput vs. ideal |
|---|---|---|
| A | Two pages, one browser | 0.13× |
| B | Two browsers, one page each | ~1.85× |

Chrome's screenshot pipeline serializes intra-process. Two tabs concurrent in the same browser made each capture take ~1400 ms instead of ~80 ms. Separate processes don't share that pipeline; mode B at K=4 hit 3.42× of ideal (~85% scaling efficiency).

**Don't "optimize" by sharing a browser across workers.** The benchmark exists; the result is unambiguous.

Memory scales linearly with K — each browser is its own Chrome process, ~300–500 MB per worker at 4K. h2v prints a non-blocking warning when the estimated total exceeds ~70% of available memory; the estimate is `~150 MB + ~30 MB × megapixels` per worker, deliberately rough.

---

## Encoding pipeline

ffmpeg consumes the captured frames and produces the final video. Per-codec arg construction lives in `buildEncodeArgs(opts)` in `cli.js`; the inputs are `opts.codec`, `opts.qualityPreset` (which influences pix_fmt, encoder preset, tune choice, ProRes profile), and `opts.crf`.

A few non-obvious encode-side choices:

- **`-tune animation`** is appended for libx264/libx265 in every quality tier except `draft`. It's a built-in x264/x265 setting calibrated for animated content (more reference frames, deblocking adjustments, psy-rd weighting tuned for sharp edges and flat regions). Not exposed as a flag because there's no scenario where a user wants it off for h2v's content type.
- **`-movflags +faststart`** is appended for any mp4/mov output. It reorders the moov atom to the start of the file so playback can begin while still downloading. Critical for web embedding; harmless for local playback.
- **`-tag:v hvc1`** is appended for libx265 in mp4/mov. Without it, QuickTime and Safari refuse to decode the stream. Apple-aware fix; harmless on other platforms.
- **`-vendor apl0`** for ProRes at the `max` tier marks the file as Apple-vendor ProRes. Some pickier NLEs require this.
- **`-x265-params log-level=error`** silences libx265's verbose per-frame stats, which have their own logger that ffmpeg's `-loglevel` doesn't reach.

After encoding, `./captures/` is wiped on exit (success or failure) — unless `--no-ffmpeg` is set, in which case the captures *are* the output and h2v leaves them alone.

---

## Code shape

```
cli.js                          # one file, one runtime dependency (puppeteer)
package.json                    # bin: { h2v, html-to-video } → cli.js
README.md                       # human-facing intro + doc map
docs/
  authoring.md                  # HTML-side contract for page authors
  cli.md                        # operator reference (presets, codecs, flags)
  internals.md                  # this file
CLAUDE.md                       # design invariants + failed approaches
demo/                           # 12-animation smoke-test storyboard
  bundle.html                   # bundle form
  animations/                   # individual-files form (same content)
tests/
  sync-test.html                # 1.5s fixture for verifying CSS/JS sync
scripts/
  sync-help-docs.js             # regenerates the --help block in docs/cli.md
.gitignore                      # node_modules, output, captures, review.html
```

`cli.js` is intentionally one file with one runtime dependency. Resist the urge to split it.

---

## See also

- **`../CLAUDE.md`** — design invariants, failed approaches, "don't change these" rules. Required reading before modifying `cli.js`.
- **`cli.md`** — full operator-side flag and preset reference.
- **`authoring.md`** — HTML-side contract: meta tags, themes, bundle markers, recording hooks.
