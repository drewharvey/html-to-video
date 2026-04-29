# Swing Landing Page Video — Frame Recording

## What this is

12 HTML animation files for a Vaadin Swing Modernization Toolkit landing page video (~1:50 runtime). Each file is a self-contained page with CSS animations and JS timers that plays a single "frame" of the storyboard.

The goal is to record each animation as a 4K MP4 video file using Puppeteer + FFmpeg.

---

## Project setup

### Prerequisites

- Node.js v18+
- FFmpeg installed and on PATH
- A terminal with Claude CLI

### Steps

1. Create the project folder and navigate into it:

```
mkdir swing-video-frames
cd swing-video-frames
```

2. Place `all-frames-bundle.html` in the project root.

3. Initialize the Node project and install Puppeteer:

```
npm init -y
npm install puppeteer
```

4. Have Claude CLI split the bundle into individual frame files (see below).

5. Have Claude CLI build the review page for local preview (see below).

6. Have Claude CLI build and run the recording script (see below).

---

## Splitting the bundle

`all-frames-bundle.html` contains all 12 frame animations in a single file, separated by markers. Ask Claude CLI to split them:

> The file `all-frames-bundle.html` contains 12 HTML animations bundled together. Each frame is wrapped in markers like:
>
> `<!-- ===== FRAME_START id="frame-01" title="The Established App" filename="frame-01-established-app.html" capture_duration="5s" ===== -->`
> `...html content...`
> `<!-- ===== FRAME_END id="frame-01" ===== -->`
>
> Split this into individual files in a `./frames/` directory, using the `filename` attribute from each FRAME_START marker as the output filename. Each output file should contain only the HTML between its FRAME_START and FRAME_END markers (not including the markers themselves).

---

## Preview: Review page

After splitting the frames, you can build a local review page that shows all 12 animations with their voiceover scripts, replay buttons, and a global light/dark toggle. Ask Claude CLI:

> Build a review page at `./review.html` that embeds all 12 frame HTML files from `./frames/` as a scrollable storyboard. Requirements:
>
> - Read each frame HTML file and embed it in an iframe using `srcdoc` (HTML-escaped). This makes the review page fully self-contained — no external file references.
> - Strip the controls div (the div with class "controls" containing Reset/Start/Theme buttons) from each frame before embedding, since the review page has its own controls.
> - Each frame should be in a card with: the frame number (F01–F12), title, a "↺ Replay" button, and the timing.
> - Below each iframe, show the voiceover script text for that frame.
> - Global controls at the top: "↺ Reload All" and a light/dark theme toggle.
> - The theme toggle must broadcast into all iframes using `postMessage({theme: 'light'})` or `postMessage({theme: 'dark'})`. Each frame already has a `window.addEventListener('message', ...)` handler that listens for this.
> - When replaying a frame (reloading its srcdoc), inject the current theme as `data-theme` on the `<html>` tag so it doesn't revert to dark mode.
> - Iframe height: 480px. Dark mode by default.
>
> The voiceover scripts for each frame are:
>
> - F01 (0–6s): "Your Swing application works. It's been serving your organization reliably for years. But the world around it has changed."
> - F02 (6–16s): "Every release means coordinating rollouts across machines. Finding developers who want to work in Swing is getting harder. And running a client-side JVM on every desktop creates security and compliance exposure you shouldn't have to manage."
> - F03 (16–22s): "The typical first instinct is to rewrite the application for the web. But rewrites are expensive, risky, and slow. Many never finish."
> - F04 (22–28s): "Vaadin's Swing Modernization Toolkit offers a different approach. It lets you move your Swing application to the web immediately — and then modernize it at your own pace."
> - F05 (28–40s): "It starts with browser access. Your existing Swing application — unchanged — runs on the server and is delivered through the browser. Your users access it through a URL, like any other web application. No desktop installs, no client-side JVM, no per-machine updates."
> - F06 (40–48s): "This can happen in days, not months. And it immediately simplifies deployment, improves your security posture, and gives your users browser-based access to the application they already rely on."
> - F07 (48–56s): "From there, you modernize incrementally. One view at a time, inside the same running application."
> - F08 (56–68s): "Old Swing views and new modern web views coexist side by side. You prioritize the highest-impact screens first, ship them as they're ready, and your users see improvements continuously — not after years of rewriting."
> - F09 (68–80s): "The toolkit includes automation that can handle 70–90% of the UI code conversion, so your team spends their time on refinement, not reconstruction. And because the entire stack is Java, there's no need to introduce JavaScript frameworks or retrain your team on a new language."
> - F10 (80–90s): "The end state isn't just a web version of your Swing app. It's a modern application on an open-source, enterprise-grade platform with 25 years of production use behind it — with built-in security, WCAG-compliant accessibility, and up to 15 years of long-term support."
> - F11 (90–98s): "Your business logic stays intact. Your team stays productive in Java, the language they already know. And you get there without ever taking the application offline."
> - F12 (98–110s): "To get started, try the free analyzer. It scans your codebase and shows you exactly how much of your application can be migrated automatically, so you know what you're looking at before you commit to anything."

To open the review page locally, just run:

```
open review.html
```

---

## Recording plan

### Approach

Use Puppeteer to open each frame HTML in a headless Chrome browser and capture screenshots, then stitch into video with FFmpeg.

- **Viewport:** 1280 × 720
- **Device scale factor:** 3 (produces 3840 × 2160 screenshots — true 4K)
- **Target framerate:** 60fps
- **Output:** One MP4 per frame, plus optionally one combined MP4

### Animation clock override (important)

The animations use `setTimeout`, `setInterval`, CSS transitions, and `requestAnimationFrame`. Taking screenshots in real-time won't guarantee smooth 60fps because screenshot encoding takes variable time.

The script should override the browser's timing APIs so that time only advances in fixed increments (16.67ms per frame at 60fps) and only when the script tells it to. This means:

- Override `Date.now()` and `performance.now()` to return a controlled clock
- Override `requestAnimationFrame` to fire on each controlled tick
- Override `setTimeout` and `setInterval` to fire based on the controlled clock
- Before each screenshot, advance the clock by 16.67ms and flush all pending callbacks
- Then take the screenshot

This produces frame-perfect video regardless of how long each screenshot takes to capture.

### Frame durations

| Frame | ID | Title | Capture duration | Frames at 60fps |
|-------|-----|-------|-----------------|----------------|
| F01 | frame-01 | The Established App | 5s | 300 |
| F02 | frame-02 | Growing Friction | 11s | 660 |
| F03 | frame-03 | The Rewrite Trap | 10s | 600 |
| F04 | frame-04 | Toolkit Introduction | 5s | 300 |
| F05 | frame-05 | Browser Reveal | 4s | 240 |
| F06 | frame-06 | Simplification | 7s | 420 |
| F07 | frame-07 | Hybrid State | 7s | 420 |
| F08 | frame-08 | Time-lapse | 10s | 600 |
| F09 | frame-09 | Automation | 7s | 420 |
| F10 | frame-10 | End State | 6s | 360 |
| F11 | frame-11 | Before / After | 6s | 360 |
| F12 | frame-12 | Call to Action | 5s | 300 |

These durations are in the FRAME_START markers as `capture_duration` attributes.

### FFmpeg command per frame

After screenshots are captured to `./captures/frame-01/`:

```
ffmpeg -framerate 60 -i ./captures/frame-01/%04d.png -c:v libx264 -pix_fmt yuv420p -crf 18 ./output/frame-01.mp4
```

- `-crf 18` = high quality (lower = bigger/better, 18 is visually lossless)
- `-pix_fmt yuv420p` = maximum player compatibility

### Dark and light variants

Each animation supports a `data-theme="light"` attribute on the `<html>` element. To record light-mode versions, have the script set this attribute after page load but before starting the capture. Record each frame twice (dark + light) or whichever is needed.

---

## Prompt for Claude CLI

Once the project is set up and frames are split, use something like:

> I have 12 HTML animation files in `./frames/`. Each is a self-contained page with CSS animations and JS timers (setTimeout, setInterval, CSS transitions, requestAnimationFrame). I need a Node.js script using Puppeteer that:
>
> 1. Opens each frame in headless Chrome at 1280×720 viewport with deviceScaleFactor 3 (producing 3840×2160 screenshots)
> 2. Overrides the browser's timing APIs (Date.now, performance.now, setTimeout, setInterval, requestAnimationFrame) so the animation clock is controlled externally — time should advance exactly 16.67ms per frame, only when the script triggers it
> 3. Captures a PNG screenshot after each clock tick
> 4. Runs for a specified number of frames per animation (see the durations in the README)
> 5. Uses FFmpeg to stitch each frame's screenshots into a 60fps MP4
>
> The frame files and their capture durations can be read from the FRAME_START markers in `all-frames-bundle.html`, or hardcoded from the README table.

---

## File structure after setup

```
swing-video-frames/
├── README.md
├── all-frames-bundle.html
├── review.html              (built by Claude CLI — local preview)
├── package.json
├── node_modules/
├── frames/
│   ├── frame-01-established-app.html
│   ├── frame-02-growing-friction.html
│   ├── ...
│   └── frame-12-cta.html
├── captures/          (created by recording script)
│   ├── frame-01/
│   │   ├── 0001.png
│   │   ├── 0002.png
│   │   └── ...
│   └── ...
├── output/            (created by recording script)
│   ├── frame-01.mp4
│   ├── frame-02.mp4
│   └── ...
└── record.js          (the Puppeteer recording script)
```