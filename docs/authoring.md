# Authoring HTML for h2v

This document is the contract between an HTML animation and the `h2v export` recorder. It describes every meta tag, attribute, and marker that h2v reads from your HTML, plus the conventions for theming and hiding UI controls during recording.

If you're building a Claude skill (or any other tool) that generates HTML for h2v to render, this file is what you need. You should not need to read the rest of the project to author conformant HTML.

---

## Two file shapes

h2v accepts two kinds of input HTML:

1. **Single-file animations** — one HTML document, one animation. Output: one video.
2. **Bundles** — one HTML document containing multiple animations, each delimited by markers. Output: one video per animation.

The shape is detected automatically: if the file contains an `ANIMATION_START` marker (or the legacy `FRAME_START`), it's a bundle. Otherwise it's a single-file animation.

---

## Single-file animations

### Minimal example

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="h2v-duration" content="5s">
  <style>
    body { margin: 0; background: #0b0b0c; }
    .ball { width: 60px; height: 60px; border-radius: 50%; background: #56a; animation: roll 5s linear; }
    @keyframes roll { from { transform: translateX(0); } to { transform: translateX(800px); } }
  </style>
</head>
<body>
  <div class="ball"></div>
</body>
</html>
```

That's it. h2v reads the duration, opens the page, captures frames, encodes a video. No JavaScript hooks, no special IDs, no opt-in attributes required.

### `<meta name="h2v-duration">` — capture duration

```html
<meta name="h2v-duration" content="8s">
```

How long h2v should record. Value is in seconds; integer or decimal both work (`8s`, `1.5s`, `12`). The trailing `s` is optional but recommended for readability.

This is the **primary** way to set duration — the CLI's `--duration` flag is an override for ad-hoc runs, and the built-in 10-second default only applies when neither is present. Always include this meta tag when generating animations programmatically; it makes the file self-describing and removes the need for any flag.

### `<meta name="h2v-themes">` — multi-theme recording (optional)

If your animation supports more than one visual theme (light/dark, brand variants, high-contrast), declare them:

```html
<meta name="h2v-themes" content="dark,light">
```

h2v will record one video per theme when the operator passes `--theme all`, or just the default theme otherwise. See [Theming](#theming) below for the CSS pattern.

Theme names match `[a-zA-Z0-9_-]+`. Pages without this meta are single-theme — h2v records them once, no theme handling.

---

## Bundle format

Multiple animations in one HTML file, each delimited by HTML comments:

```html
<!-- ===== ANIMATION_START id="intro" capture_duration="5s" ===== -->
<!DOCTYPE html>
<html>
  <head>...</head>
  <body>...the animation...</body>
</html>
<!-- ===== ANIMATION_END id="intro" ===== -->

<!-- ===== ANIMATION_START id="reveal" capture_duration="8s" title="The reveal" ===== -->
<!DOCTYPE html>
<html>
  ...
</html>
<!-- ===== ANIMATION_END id="reveal" ===== -->
```

h2v writes each animation to `output/<bundle-base>/<animation-id>.<ext>`.

### Required marker attributes

| Attribute | Notes |
|---|---|
| `id` | Used as the output filename. Must be unique within the bundle. |
| `capture_duration` | Same format as `h2v-duration` (e.g. `5s`, `1.5s`, `12`). |

### Optional marker attributes

| Attribute | Notes |
|---|---|
| `title` | Human-readable label shown in console logs. Defaults to `id`. |
| `themes` | Comma-separated theme list (e.g. `themes="dark,light"`). Same semantics as `<meta name="h2v-themes">` but per-animation. |

Other attributes are tolerated and ignored. The legacy form `FRAME_START` / `FRAME_END` also works for backward compatibility.

### Each animation is its own document

The HTML inside each pair of markers is loaded as a complete document. Each animation gets its own browser context — there's no shared state. `<style>`, `<script>`, viewport, etc. are per-animation.

---

## Hiding UI controls during recording

Animations often include on-page affordances (Reset button, theme toggle, debug overlay) that you want visible while authoring or reviewing but **not** in the recorded video. Two hooks let pages cooperate:

### `data-h2v-hide` — the common case

Mark elements that should disappear during recording:

```html
<div data-h2v-hide class="controls">
  <button id="reset">Reset</button>
  <button id="theme">☀ Light</button>
</div>
```

During `h2v export`, h2v injects a stylesheet `[data-h2v-hide] { display: none !important; }`. The page itself doesn't need any CSS or JS for this to work — controls remain interactive when you open the file in a normal browser.

### `data-h2v-recording` — the advanced case

During `h2v export`, h2v also sets `data-h2v-recording` (no value) on `<html>`. Use this when you need to do more than hide an element:

```css
html[data-h2v-recording] .debug-fps { display: none; }
html[data-h2v-recording] .stage { padding: 0; }
```

```js
if (document.documentElement.hasAttribute('data-h2v-recording')) {
  // we're in a recording; skip the ambient idle animation
}
```

Neither attribute is set during `h2v review` (the inspection mode) — controls stay visible there.

---

## Theming

Optional. Declare available themes once; h2v can record one video per theme.

### CSS pattern

```html
<head>
  <meta name="h2v-themes" content="dark,light">
  <style>
    /* The first declared theme is the DEFAULT. Style your CSS as if no
       theme attribute were set — that's what h2v sends for the default. */
    body { background: #0b0b0c; color: #e6e6e8; }

    /* Every other declared theme: h2v sets data-theme="<name>" on <html>
       after navigation. React however you want. */
    [data-theme="light"] body { background: #f4f4f5; color: #18181b; }
  </style>
</head>
```

### Rules

- The **first** theme listed in the meta is the default. h2v records it with **no** `data-theme` attribute set, and the output file has **no** filename suffix.
- Every **other** theme: h2v sets `data-theme="<name>"` on `<html>` after navigation, and suffixes the output filename with `-<name>` (e.g. `anim-light.mp4`).
- Theme names match `[a-zA-Z0-9_-]+`. `dark` / `light` are conventions, not reserved.
- Pages without a `h2v-themes` meta are single-theme.

### Bundle equivalent

```html
<!-- ===== ANIMATION_START id="hero" capture_duration="5s" themes="dark,light" ===== -->
```

Each animation in a bundle has its own theme list — they don't have to match.

---

## Suggested prompt for AI generation

When asking an LLM to generate an animation for h2v, include something like:

> Generate a single self-contained HTML file. In `<head>` include `<meta name="h2v-duration" content="Ns">` where N is the number of seconds the animation needs to play through once. Wrap any UI controls (buttons, toggles) in an element with `data-h2v-hide` so they're invisible during recording but interactive in a browser preview.

That's the minimum the file needs to cooperate with h2v. Add the theming or bundle conventions if the use case calls for them.

---

## What h2v does NOT touch

- **No JavaScript imports.** h2v doesn't inject any script tags into your page (other than the time-slowdown shim that runs before any of your code).
- **No layout assumptions.** h2v records whatever fills the configured viewport (`--width` × `--height`, default 1280×720). If your animation overflows, the overflow is cropped.
- **No required IDs, classes, or framework.** Plain HTML/CSS/JS or any framework that compiles to it.
- **No required wait signal.** h2v starts capturing immediately after `load`. If your animation needs setup time before the "real" motion begins, build that into the duration or shift the animation to start later.

---

## Reference

- **Operator-side flags and behavior**: [`cli.md`](cli.md)
- **How recording actually works under the hood**: [`internals.md`](internals.md)
- **Worked example with 12 animations**: [`../demo/`](../demo/)
