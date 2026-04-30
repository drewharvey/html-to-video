# html-to-video

Record HTML animations as 4K MP4s. Drop a file in a folder, run `h2v export`, get a video.

Designed for the workflow of generating animations with Claude (e.g. at claude.ai) and exporting them locally without dragging anything into a screen recorder.

The package is `html-to-video`; the daily-typing command is `h2v` (with `html-to-video` available as a longer alias).

---

## Quickstart

```
git clone <this repo>
cd <cloned directory>
npm install
npm install -g .                 # exposes `h2v` and `html-to-video` on PATH

cd /path/to/your/animations
h2v export                       # records every *.html in this dir
```

That's it. MP4s land in `./output/`.

---

## Prerequisites

- **Node.js 18+**
- **ffmpeg** on PATH (`brew install ffmpeg` on macOS, `apt install ffmpeg` on Debian/Ubuntu)
- A working Chrome/Chromium that Puppeteer can launch. On macOS and x86_64 Linux this is automatic via the bundled download. On ARM64 Linux, Google publishes no Chrome — set `PUPPETEER_EXECUTABLE_PATH` to a system-installed Chromium.

---

## Usage

```
h2v export                       # all *.html in cwd (non-recursive)
h2v export animation.html        # one file
h2v export bundle.html           # bundles auto-detected
h2v export a.html b.html dir/    # explicit list, mixing files and dirs

h2v export --theme both          # produce dark + light variants
h2v export --duration 8s solo.html
h2v export --dry-run             # print plan without recording
```

Default settings match the original recording configuration that produced the reference videos: 60fps, 1280×720 viewport with deviceScaleFactor 3 (so screenshots come out 3840×2160 = 4K), x264 with `crf 18` and `yuv420p`. All overridable via flags.

In **directory mode** (no path args, or when a directory is passed) `h2v` skips files starting with `.` and any file literally named `review.html`. Explicitly named file arguments bypass these filters — if you want to record `review.html`, just name it directly.

---

## How it works

1. Each animation is opened in headless Chrome at the chosen viewport.
2. Before any page script runs, `h2v` injects a small shim that **slows every JS time source** by a factor `S` (`--slowdown`, default 10):
   - `setTimeout` / `setInterval` delays are multiplied by `S`
   - `performance.now()` and `Date.now()` return real-elapsed-time / `S`
   - `requestAnimationFrame` callback timestamps are scaled the same way
3. After navigation, `h2v` slows CSS animations and transitions by the matching factor via the CDP Animation domain (`Animation.setPlaybackRate(1/S)`).
4. With both layers slowed identically, a 1-second animation takes `S` seconds of wall time. `h2v` captures one PNG every `(1000 / fps) × S` ms of wall time, so each frame lands at the correct moment of the original animation.
5. PNGs go to `./captures/<job>/0001.png` … and ffmpeg stitches them into MP4s with `-c:v libx264 -pix_fmt yuv420p -crf 18`. The output plays back at the original speed.
6. `./captures/` is wiped on exit — both on success and failure — unless `--no-ffmpeg` is set.

**Trade-off:** total recording wall time = animation duration × slowdown. With the default S = 10, a 5-second animation takes 50 seconds to record. If your screenshots are fast (small viewport / low scale), you can lower `--slowdown` for faster recording.

---

## Setting per-file duration

For a **single-file animation**, h2v needs to know how long to record. In priority order:

1. A `<meta>` tag in the HTML's `<head>`:
   ```html
   <meta name="h2v-duration" content="8s">
   ```
2. The `--duration` flag on the command line.
3. The default (10 s).

For **bundles**, the duration of each frame is taken from the `capture_duration` attribute on its `FRAME_START` marker (see below).

### Suggested claude.ai prompt addition

When asking Claude to generate an animation, include something like:

> *In the `<head>` include `<meta name="h2v-duration" content="Ns">`, where N is the number of seconds the animation needs to play through once.*

Then `h2v export` picks the right length automatically with no flags.

---

## Bundle format (multi-frame storyboards)

Multiple animations can live in one HTML file, each delimited by markers. `h2v` emits one MP4 per frame, named `output/<bundle-base>/<frame-id>.mp4`.

```html
<!-- ===== FRAME_START id="frame-01" title="Intro" capture_duration="5s" ===== -->
<!DOCTYPE html>
<html>
  <head>...</head>
  <body>...the animation...</body>
</html>
<!-- ===== FRAME_END id="frame-01" ===== -->

<!-- ===== FRAME_START id="frame-02" title="Reveal" capture_duration="8s" ===== -->
...
<!-- ===== FRAME_END id="frame-02" ===== -->
```

Required marker attributes: `id` and `capture_duration`. `title` is optional (used in console logs). Other attributes (such as `filename`) are tolerated but ignored.

A worked example with twelve frames lives in [`examples/swing-video/`](examples/swing-video/).

---

## Flag reference

| Flag | Default | Effect |
|---|---|---|
| `--duration <Ns>` | `10s` | Single-file capture duration when no `<meta>` tag is present. Bundles ignore this. |
| `--fps <N>` | `60` | Frame rate. |
| `--width <N>` | `1280` | Viewport width in CSS pixels. |
| `--height <N>` | `720` | Viewport height in CSS pixels. |
| `--scale <N>` | `3` | Device scale factor. With defaults this gives 3840×2160 (4K). |
| `--crf <N>` | `18` | x264 CRF (0–51). Lower = bigger/better; 18 is visually lossless. |
| `--slowdown <N>` | `10` | Real-time slowdown factor. The browser plays animations at `1/N` speed so screenshots can keep up; the resulting MP4 plays back at the original speed. Total recording wall time = animation duration × N. Use `1` to disable (only works if a screenshot fits in one frame interval — usually not at 4K). |
| `--theme <m>` | `dark` | `dark`, `light`, or `both`. `both` produces two MP4s per animation; light has a `-light` filename suffix. |
| `--out-dir <path>` | `./output` | Output directory. |
| `--out <path>` | — | Exact output filename. Only valid when exactly one MP4 will be produced. |
| `--no-ffmpeg` | off | Capture PNGs only; skip stitching and the cleanup step. |
| `--dry-run` | off | Print the recording plan and exit (no browser launched). |
| `-h`, `--help` | | Show help. |
| `--version` | | Show version. |

Environment variables:

| Var | Effect |
|---|---|
| `PUPPETEER_EXECUTABLE_PATH` | Override the browser binary Puppeteer launches. Useful when the bundled Chrome can't run on your host. |

---

## Limitations

- **No recursion.** Directory expansion only finds `*.html` at the top level of the named directory.
- **Single-shot per page.** Each animation is recorded by playing through once from t=0. If your animation loops, the recording stops at the configured duration regardless.
- **Recording is slow.** With the default `--slowdown 10`, recording takes 10× the animation's run time. A 30-second animation needs five minutes of wall time. Lower the slowdown if your screenshots are fast.
- **Web Workers, WebSockets, and `fetch` are not slowed.** The shim only wraps `setTimeout` / `setInterval` / `performance.now` / `Date.now` / `requestAnimationFrame` on the main thread. Animations from any of those uncommon sources will desync with the rest. Not relevant for typical Claude-generated animations.

---

## Examples

- **`examples/swing-video/`** — 12-frame product video bundle for the Vaadin Swing Modernization Toolkit. Includes the original bundle, the split per-frame files, and a small `build-review.js` script that generates a local browser preview page.
