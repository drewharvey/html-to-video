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

## The seek driver

`recordJob` actually has **two frame drivers**, picked per-job by capability detection. The slowdown trick above is the **play driver** — the universal fallback that works on any HTML. The **seek driver** is a fast path for pages that cooperate.

The slowdown trick exists only because h2v has to *play* an animation it doesn't understand. A page that exposes its scene as a pure function of time removes that constraint entirely: instead of advancing a clock and racing screenshots, h2v asks the page for each frame's exact state.

### Detection

After navigation, `recordJob` probes the page:

```js
const seekable = await page.evaluate(() => typeof window.seek === 'function');
```

Present → seek driver. Absent → play driver. The function's presence is both the capability signal *and* the hook h2v calls — there's no separate metadata global. Duration and viewport come from the meta tags h2v already parsed pre-launch (`buildPlan` runs before any browser launches), so detection only decides *how to drive*, never *how big* or *how long*.

`window.__SCRUB__ = true` is injected unconditionally before load — on the same `evaluate`-before-`setContent` / `evaluateOnNewDocument`-before-`goto` paths as the slowdown shim. It tells a seek-aware page not to autoplay (render frame 0, wait). It's inert for play-driven pages. It has to be set before page scripts run, but the driver can only be detected after load, so it's set unconditionally and the driver decided afterward.

### Capture loop

```
await document.fonts.ready        (+ a short settle — the play path leans on
                                   the slowdown to give fonts time; seek
                                   captures frame 0 almost immediately)
for i in [0, totalFrames):
    window.seek(i × 1000/fps)
    screenshot
encode the resulting frames at fps
```

No pacing sleep — that deletion is the whole win. Wall time ≈ N screenshots, not `duration × S`. Frames span `[0, duration)` (capturing the true first frame at t=0) and are written 1-based on disk (`0001…N`) so the sequence matches `ffmpegStitch`'s `-start_number 1`, identical to the play path. The seek driver never touches the CDP `Animation` domain — there's no clock to slow.

### It's auto-only, with a visible choice

There's no `--driver` / `--seek` flag. For a generic tool the default has to handle the generic case (arbitrary HTML), so seek can only ever be an opt-in fast path, never the default — detection picks it automatically when the page cooperates. The one observability affordance is that each job logs which driver it used (`driver: seek …` / `driver: slowdown N×`), so a page that *meant* to be seek-driven but isn't being detected (a typo'd hook, an un-suppressed autoplay) is visible rather than silently downgraded. See `CLAUDE.md` for the design rationale and the authoring-side contract in [`authoring.md`](authoring.md).

Fixture + test: `tests/seek-test.html`, `npm run test:seek`.

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

## Alpha-channel recording

The `--alpha` flag produces a `.mov` with a real per-pixel alpha channel, suitable for compositing in NLEs. Three things happen together when the flag is set:

1. **Capture format forced to PNG.** JPEG has no alpha channel; PNG does.
2. **`omitBackground: true` passed to `Page.captureScreenshot`.** Chromium normally paints a white viewport before rendering page content; `omitBackground` skips that paint, exposing whatever the page itself paints (or transparency, where the page paints nothing).
3. **Encoder defaults to `png` codec in `.mov`** (PNG-in-MOV: bit-exact lossless, straight alpha by codec spec). Users can opt into `prores_ks` profile 4 (`yuva444p10le`) via `--codec prores_ks` for Apple-ecosystem pro workflows.

These three are coupled — `--alpha` rejects explicit `--codec`/`--container`/`--capture-format` flags that would break any of them.

### Why PNG-in-MOV is the default

Chrome's `Page.captureScreenshot` produces **straight alpha** (RGB stored at full strength, alpha separate — verified by sampling glow pixels at known anti-aliased edges). For an NLE to render this correctly, it needs to know the alpha mode of the file it's loading.

The PNG codec spec mandates straight alpha at the codec level. There's no metadata flag to set or guess at — every decoder, in every player, interprets PNG alpha the same way. That structural property is what makes PNG-in-MOV reliable.

ProRes 4444 is the opposite: alpha mode lives in a MOV extension (`kCMFormatDescriptionExtension_AlphaChannelMode`) that ffmpeg's `prores_ks` muxer doesn't write. Without the tag, players guess — QuickTime/FCP guess straight (correct for our content), CapCut and several web editors guess premultiplied (wrong). When a player premultiplies a file that's already straight, a semi-transparent pink glow at α=13 with R=255 gets rendered as "5% mix of full-strength pink" rather than "5% mix of darkened pink" — bright halo instead of soft falloff. Verified empirically against CapCut.

PNG-in-MOV also happens to be **~6× smaller** for h2v's content (synthetic vector-style animations with large flat regions and transparent surrounds). PNG's per-frame zlib + filter compression is exceptionally well-suited to this; ProRes 4444's near-CBR is engineered for high-entropy live-action mastering, so it allocates bitrate even where there's almost nothing to encode.

### Codec matrix for alpha output

| Codec | Container | Verdict |
|---|---|---|
| **`png` (default)** | `.mov` | **Bit-exact lossless. Straight alpha per codec spec. Universal NLE compatibility. ~6× smaller than ProRes 4444 for h2v's content.** |
| `prores_ks` (opt-in) | `.mov` | 10-bit chroma, larger files, ambiguous alpha-mode metadata. Use only if the pipeline specifically expects ProRes 4444. |
| libx264 | mp4/mov | No alpha encoder. |
| libx265 | mp4/mov | Spec supports alpha; libx265 doesn't expose it portably. |
| libvpx-vp9 | webm | Encoder advertises `yuva420p` but ffmpeg's wrapper silently drops the alpha plane in the simple invocation. Achievable via multi-stream remux but fragile across ffmpeg versions; deferred. |
| hevc_videotoolbox | mov | macOS-only encoder; non-portable. Visually lossless but lossy; alpha is premultiplied per Apple's spec. Could be added with `-vf premultiply=inplace=1` pre-encode for correct rendering. |
| qtrle | mov | Lossless, alpha, similar size to PNG-in-MOV. Same straight-alpha advantage. Skipped — PNG-in-MOV is the cleaner default. |

### Authoring caveat

`omitBackground` only exposes the page's own paint. If the page sets an opaque `body { background: ... }`, the recording is opaque. The authoring rule (`html, body { background: transparent }` or no `background` at all) is documented in [`authoring.md`](authoring.md). h2v doesn't inject a stylesheet to enforce this — pages with intentional backgrounds for non-alpha runs would be surprised by it.

### Fixing ProRes 4444 alpha rendering (future work)

The CapCut "glow blow-out" bug for ProRes 4444 is fixable with a one-line ffmpeg filter: `-vf premultiply=inplace=1` before the encoder pre-multiplies the RGB so any player guessing premultiplied gets correct math. The catch: it breaks playback in players that guess straight (QuickTime/FCP). The correct fix is to write the `kCMFormatDescriptionExtension_AlphaChannelMode = "Straight"` tag into the MOV, but ffmpeg's mov muxer doesn't expose that as a CLI knob. Until that's available, PNG-in-MOV remains the universally-correct default.

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
