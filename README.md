# html-to-video

Convert HTML animations to video files. Drop a file in a folder, run `h2v export`, get a video. Defaults to 4K 60fps MP4 (h264); every output parameter is configurable.

The companion `h2v review` command builds a single self-contained HTML page that embeds every animation at the given paths, for side-by-side preview in a browser.

## Install

Prerequisites:

- **Node.js 18+**
- **ffmpeg** on PATH (`brew install ffmpeg` on macOS, `apt install ffmpeg` on Debian/Ubuntu)
- A working Chrome/Chromium for Puppeteer to launch. Bundled automatically on macOS and x86_64 Linux. On ARM64 Linux, set `PUPPETEER_EXECUTABLE_PATH` to a system-installed Chromium.

```
git clone <this repo>
cd <cloned directory>
npm install
npm install -g .
```

Exposes `h2v` and `html-to-video` on your PATH (same binary, two names; pick whichever you prefer to type).

## Usage

```
h2v export                                # all *.html in cwd (non-recursive)
h2v export animation.html                 # one file
h2v export bundle.html                    # bundles auto-detected
h2v export ./anims --concurrency 8        # parallel batch
h2v export --quality-preset high          # higher-fidelity tier
h2v export --theme all                    # one video per declared theme
h2v export --dry-run                      # print plan, no recording

h2v review ./anims                        # browser preview of every animation
h2v review bundle.html --out review.html  # save the preview to a real path
```

Videos land in `./output/` by default; see [`docs/cli.md`](docs/cli.md) for the path scheme, directory-mode filters, and `--out` / `--out-dir` overrides.

A worked example: [`demo/`](demo/) contains a 12-animation storyboard exercising all three usage modes (single file, directory, bundle).

## CLI options

`h2v --help` prints the full flag list. The main categories:

- **Output quality** — codec, container, capture format and quality, CRF, quality presets
- **Resolution and frame rate** — viewport, device scale factor, fps
- **Selection** — theme, duration override
- **Performance** — parallel concurrency, recording slowdown
- **Output paths** — output directory, exact filename, dry-run, no-encode

For values, defaults, validation, and edge cases: [`docs/cli.md`](docs/cli.md).

## Authoring HTML for h2v

h2v reads a few conventions from your HTML to know how to record it:

- `<meta name="h2v-duration" content="5s">` — recording length.
- `<meta name="h2v-themes" content="dark,light">` — opt-in multi-theme recording.
- `<meta name="h2v-viewport" content="1280x720">` — design viewport for non-default aspects (1:1, 9:16, etc.).
- `data-h2v-hide` on any element — hide during recording.
- `data-h2v-recording` on `<html>` (set by h2v while recording) — for CSS or JS that reacts to recording mode.
- Bundle markers (`<!-- ===== ANIMATION_START id="..." capture_duration="5s" ===== -->` … `ANIMATION_END`) — multiple animations in one file.

Full reference: [`docs/authoring.md`](docs/authoring.md).

## How it works

To capture frames reliably at high resolution, h2v slows the page's clocks during recording by a factor `S` (default 6, `--slowdown`), then stitches the captured frames back at the original fps. Recording wall time ≈ animation duration × `S`.

Why this approach, and the failed alternatives behind it: [`docs/internals.md`](docs/internals.md).

---

## Development

For modifying h2v itself.

### Local install

Use `npm link` instead of `npm install -g .` — it symlinks the global `h2v` command to your working tree, so edits to `cli.js` are picked up immediately:

```
git clone <this repo>
cd <cloned directory>
npm install
npm link
```

### Help-text sync

`cli.js`'s `HELP_TEXT` is the canonical source for the flag list. After editing it, run `npm run docs:sync` to regenerate the auto-managed block in `docs/cli.md`. `npm run docs:check` is the read-only variant; the `docs-check` GitHub Actions workflow gates pushes to `main`.

### Tests

[`tests/sync-test.html`](tests/sync-test.html) is a 1.5-second fixture for verifying that CSS- and JS-driven animations stay in lockstep during recording. There is no `npm test` script — the project's testing is fixture-based.

### Required reading

[`CLAUDE.md`](CLAUDE.md) is required reading before changing `cli.js` — design invariants, the "things that aren't broken — don't change them" list, and the failed-approaches table for the recording mechanism. Several pitfalls have been hit and documented there; skipping it costs hours.

### Uninstall

Whichever install mode you used:

```
npm uninstall -g html-to-video      # if you ran `npm install -g .`
npm unlink -g html-to-video         # if you ran `npm link`
```

To remove local artifacts (all gitignored):

```
rm -rf node_modules output captures
```

If you used `npm link`, run `npm unlink` *before* renaming or moving the directory — the link is an absolute-path symlink and a rename leaves it broken.

## Documentation

- [`docs/authoring.md`](docs/authoring.md) — full HTML authoring contract.
- [`docs/cli.md`](docs/cli.md) — full CLI reference (auto-synced from `h2v --help`).
- [`docs/internals.md`](docs/internals.md) — recording-mechanism deep-dive.
- [`CLAUDE.md`](CLAUDE.md) — repo design invariants and contributor guidance.
