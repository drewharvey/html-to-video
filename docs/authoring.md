# Authoring HTML for h2v

The complete contract between an HTML animation and the `h2v export` recorder: every meta tag, attribute, and marker that h2v reads from your HTML, plus the conventions for theming and hiding UI controls during recording.

The README has a summary suitable for the common case. This file is the full reference — useful when you need exact behavior, are working with the more advanced features (multi-theme recording, bundles, recording-time CSS/JS reactions), or are writing tooling that produces HTML for h2v.

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

### `<meta name="h2v-viewport">` — design viewport (optional)

Declare the resolution your animation was designed for:

```html
<meta name="h2v-viewport" content="1280x720">
```

Format is `<width>x<height>` in CSS pixels — integers, no units, no spaces. Common values: `1280x720` (16:9 landscape, default), `1080x1080` (1:1 square), `720x1280` (9:16 portrait).

Honored by both `h2v export` (sets each recording's viewport per animation) and `h2v review` (sizes each iframe correctly when previewing a mix of aspect ratios on one page). Without this meta, both default to 1280×720.

The CLI's `--width` / `--height` flags override the meta for ad-hoc runs. They're a coupled pair — passing either flag makes both override every per-animation viewport for the rest of the run.

---

## Bundle format

Multiple animations in one HTML file, each delimited by HTML comments. This format exists for workflows where moving many separate files around is awkward — for example, a chat interface that emits a single downloadable file, or a pipeline where one HTML payload is easier to ship than N. If you're already producing files locally, individual files in a directory is usually simpler; bundles aren't preferred when both options are available.

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
| `viewport` | Design viewport in `WxH` format (e.g. `viewport="1080x1080"`). Same semantics as `<meta name="h2v-viewport">` but per-animation. Default: `1280x720`. |

Other attributes are tolerated and ignored. The legacy form `FRAME_START` / `FRAME_END` also works for backward compatibility.

### Each animation is its own document

The HTML inside each pair of markers is loaded as a complete document. Each animation gets its own browser context — there's no shared state. `<style>`, `<script>`, viewport, etc. are per-animation.

---

## Hiding UI controls during recording

Animations often include on-page affordances (Reset button, theme toggle, debug overlay) that you want visible while authoring or reviewing but **not** in the recorded video. Two hooks let pages cooperate:

### `data-h2v-hide` — the common case

Mark elements that should disappear during recording:

```html
<div class="controls" data-h2v-hide>
  <button onclick="location.reload()">↺ Reset</button>
  <!-- theme swatches, debug toggles, etc. live in here too -->
</div>
```

During `h2v export`, h2v injects a stylesheet `[data-h2v-hide] { display: none !important; }`. The page itself doesn't need any CSS or JS for this to work — controls remain interactive when you open the file in a normal browser.

**Conventions for the controls bar:**

- **One container.** Put the Reset button, theme switcher, and any other dev affordances into a single `data-h2v-hide` element so they share placement and lifecycle. Two separate `data-h2v-hide` containers in the same animation is a code smell.
- **Reset button.** Use the label `↺ Reset` (the U+21BA arrow + the word "Reset") and `location.reload()` as the click handler. This restarts every animation deterministically without per-animation state-management JS. The convention is established by the `demo/animations/` storyboard.
- **Theme persists across Reset.** Because Reset is a full page reload, the in-page theme switcher needs to persist its current selection — otherwise clicking Reset reverts the page to the default theme, which is rarely what the user wants. The pattern: `applyTheme(target)` writes the choice to `sessionStorage` (or removes the key for the default), and a tiny inline `<script>` in `<head>` (before any styles paint) reads it back on load and reapplies. h2v's recording is unaffected — each worker spawns a fresh browser with empty sessionStorage, so the head script is a no-op and h2v's post-load `setAttribute('data-theme', …)` still wins. See [Theme switcher pattern](#theme-switcher-pattern-in-page-ui) for the full implementation.
- **Theme switcher.** When the animation declares `<meta name="h2v-themes">`, the switcher sits next to the Reset button in the same bar. See [Theme switcher pattern](#theme-switcher-pattern-in-page-ui) below for the behavior contract.

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

### CSS-variable pattern (recommended for non-trivial palettes)

For animations with more than two or three themed properties, declaring CSS variables on `:root` and overriding them per `[data-theme]` is more maintainable than restyling each rule:

```css
:root {
  /* Default theme (first listed in <meta name="h2v-themes">). */
  --bg: #0f0f0f; --surface: #1a1a1a;
  --text: #ffffff; --accent: #056ff0;
}
[data-theme="light"] {
  --bg: #ffffff; --surface: #f0f4f7;
  --text: #0f0f0f; --accent: #056ff0;
}
[data-theme="vibrant"] {
  --bg: #1a0033; --surface: #2d0a52;
  --text: #fff8ff; --accent: #ff2eb8;
}

body { background: var(--bg); color: var(--text); }
.card { background: var(--surface); }
.cta  { background: var(--accent); }
```

Each rule that uses a themed value reads from a variable; the per-theme block only declares the variable values.

### Bundle equivalent

```html
<!-- ===== ANIMATION_START id="hero" capture_duration="5s" themes="dark,light" ===== -->
```

### Theme switcher pattern (in-page UI)

Add a visual theme switcher on the page so you can preview each theme in a normal browser without invoking h2v. The switcher sits in the same `data-h2v-hide` controls bar as the Reset button (see [conventions for the controls bar](#data-h2v-hide--the-common-case) above). The storyboard in [`../demo/animations/`](../demo/animations/) shows the canonical implementation — circular gradient swatches in line with the Reset button.

**Behavior contract:**

1. **Click jumps directly to that theme.** No cycling through every theme to reach the one you want.
2. **The default theme has no `data-theme` attribute** on `<html>`. Selecting the default calls `removeAttribute('data-theme')`. This mirrors `h2v export` so the local preview matches the recorded output exactly.
3. **Non-default themes set `data-theme="<name>"`** — same as h2v's recording.
4. **The active option is visually indicated** (use `aria-pressed="true"` and a CSS rule).
5. **Wrap the whole switcher in `data-h2v-hide`** alongside the Reset button so h2v hides them during export but they stay interactive in any browser preview.
6. **Disable theme-related CSS transitions during recording** if you have any. Add `html[data-h2v-recording] body { transition: none; }` so h2v captures the theme applied instantly at frame 0 instead of fading in from the default over the first frames. (Skip if your body has no `transition` on color/background.)

**Visual is your call** as long as the behavior contract above holds. The storyboard's canonical look is gradient-filled circular swatches because they're compact enough to sit inline with a Reset button, but a vertical list of palette strips, labeled pills, a dropdown, or a named-button row are all valid implementations.

**Minimal JS implementation:**

```js
// Body, end of <script>:
const DEFAULT_THEME = 'dark';  // first entry in <meta name="h2v-themes">

function applyTheme(target) {
  if (target === DEFAULT_THEME) {
    document.documentElement.removeAttribute('data-theme');
    try { sessionStorage.removeItem('h2v-theme'); } catch (e) {}
  } else {
    document.documentElement.setAttribute('data-theme', target);
    try { sessionStorage.setItem('h2v-theme', target); } catch (e) {}
  }
}
```

```html
<!-- Head, before any styles paint, so the restored theme is applied
     before first paint and there's no flash of the default theme: -->
<script>
  try {
    var t = sessionStorage.getItem('h2v-theme');
    if (t) document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
</script>
```

The `sessionStorage` round-trip survives `location.reload()` (so Reset preserves the user's theme selection) but doesn't leak across browser tabs or sessions. h2v's recording is unaffected — each worker spawns a fresh browser with empty sessionStorage, so the head script is a no-op and h2v's post-load `setAttribute` still wins.

Avoid the older binary `cycleTheme()` pattern that toggles between exactly two themes — it doesn't generalize to three or more, and it doesn't match how h2v records (which always sets the attribute deterministically per theme).

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
