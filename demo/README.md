# Demo

A 12-animation Vaadin Swing Modernization Toolkit storyboard, set up to exercise all three of `h2v`'s export modes. Use it as a quick smoke test after install or after changes to `cli.js`.

## What's here

```
demo/
├── README.md
├── bundle.html          # all 12 animations concatenated, with markers
└── animations/          # the same 12 animations as standalone files
    ├── 01-established-app.html
    ├── 02-growing-friction.html
    ├── …
    └── 12-cta.html
```

Both `bundle.html` and the files in `animations/` produce the same set of MP4s — they just demonstrate the two input shapes `h2v` accepts.

## Try the three usage modes

From the project root, with `h2v` available on PATH (`npm install -g .` or via `node cli.js`):

**1. Export a single animation file**
```
h2v export demo/animations/09-automation.html
```
Produces `output/09-automation.mp4`.

**2. Export every animation in a directory**
```
h2v export demo/animations/
```
Produces `output/01-established-app.mp4` … `output/12-cta.mp4` (12 files).

**3. Export a bundle**
```
h2v export demo/bundle.html
```
Produces `output/bundle/01-established-app.mp4` … `output/bundle/12-cta.mp4` (12 files in a nested directory).

Add `--dry-run` to any of these to preview the plan without recording.

## Preview without recording

`h2v review` works on the same inputs and is much faster — it builds a single HTML page with every animation embedded as an iframe, opens it in your browser, and deletes the temp file when you Ctrl-C:

```
h2v review demo/animations/   # all 12 standalones in one page
h2v review demo/bundle.html   # same content, sourced from the bundle
```

## Looking for the sync test?

If you want the minimal fast fixture for verifying the recorder's CSS/JS timing, that lives in [`tests/sync-test.html`](../tests/) — it's not really demo content.

## How the durations are configured

For the **bundle**, each animation's capture length comes from the `capture_duration` attribute on its `ANIMATION_START` marker:

```html
<!-- ===== ANIMATION_START id="01-established-app" title="The Established App" filename="01-established-app.html" capture_duration="5s" ===== -->
<!DOCTYPE html>
<html>...</html>
<!-- ===== ANIMATION_END id="01-established-app" ===== -->
```

For the **standalone files**, each one carries a `<meta name="h2v-duration">` in its `<head>`:

```html
<meta name="h2v-duration" content="5s">
```

The two sources are kept in sync; both modes record the same content for the same number of frames.

## Bundle marker format reference

A bundle is a single `.html` file containing one or more animations, each delimited by a pair of comment markers:

```html
<!-- ===== ANIMATION_START id="<unique-id>" capture_duration="<N>s" ===== -->
<!DOCTYPE html>
<html>
  <head>...</head>
  <body>...the animation...</body>
</html>
<!-- ===== ANIMATION_END id="<unique-id>" ===== -->
```

Required marker attributes: `id` (used as the output filename) and `capture_duration`. Other attributes (`title`, `filename`, anything else) are tolerated and ignored. The legacy form `FRAME_START` / `FRAME_END` also works for backward compatibility.
