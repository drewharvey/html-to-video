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
2. **Before any page script runs**, `h2v` overrides `Date`, `performance.now`, `setTimeout`, `setInterval`, and `requestAnimationFrame` with a virtual clock that only advances when the recorder ticks it. This makes screenshot timing deterministic regardless of how long encoding takes per frame.
3. For each output frame, the clock advances by `1000 / fps` ms (16.67 ms at 60fps), all queued callbacks fire, then a PNG is captured.
4. PNGs go to `./captures/<job>/0001.png` … and ffmpeg stitches them into MP4s with `-c:v libx264 -pix_fmt yuv420p -crf 18`.
5. `./captures/` is wiped on exit — both on success and failure — unless `--no-ffmpeg` is set.

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

- **CSS animations are real-time.** The virtual clock controls JS timing (`Date`, `setTimeout`, `requestAnimationFrame`, etc.). CSS `transition` and `animation` properties are still composited against wall-clock time by Chromium. In practice this is fine — screenshots happen quickly between virtual ticks — but if you ever see CSS-driven motion that looks subtly off, fully frame-perfect CSS would require Chromium's `Emulation.setVirtualTimePolicy` over CDP, which isn't wired up.
- **No recursion.** Directory expansion only finds `*.html` at the top level of the named directory.
- **Single-shot per page.** Each animation is recorded by playing through once from t=0. If your animation loops, the recording stops at the configured duration regardless.

---

## Examples

- **`examples/swing-video/`** — 12-frame product video bundle for the Vaadin Swing Modernization Toolkit. Includes the original bundle, the split per-frame files, and a small `build-review.js` script that generates a local browser preview page.
