# html-to-video

Convert HTML animations to video files. Drop a file in a folder, run `h2v export`, get a video.

Defaults to 4K 60fps MP4 (h264). Every output parameter is configurable — alternate codecs (h265, VP9, ProRes), containers (mp4/mov/webm), frame-capture format, resolution, fps, quality presets, and CRF.

The package is `html-to-video`; the daily-typing command is `h2v` (with `html-to-video` available as a longer alias).

## Documentation

- **[docs/authoring.md](docs/authoring.md)** — HTML authoring contract: meta tags, themes, bundle markers, recording hooks. **Read this if you're building a Claude skill or any other tool that generates HTML for h2v.**
- **[docs/cli.md](docs/cli.md)** — Full CLI reference: flags (auto-synced from `h2v --help`), quality presets, codec details, parallel recording, troubleshooting.
- **[docs/internals.md](docs/internals.md)** — How recording actually works: the time-slowdown trick, JS shim, CSS playback rate, parallel job model. For contributors.
- **[CLAUDE.md](CLAUDE.md)** — Repo design invariants and "things that aren't broken — don't change them." For people working on h2v itself.

## Quickstart

```
git clone <this repo>
cd <cloned directory>
npm install
npm install -g .                 # exposes `h2v` and `html-to-video` on PATH

cd /path/to/your/animations
h2v export                       # records every *.html in this dir
```

Videos land in `./output/` (default `.mp4`; the extension follows `--container`).

`npm install -g .` copies the current state of the repo into your global `node_modules`. Use `npm link` instead if you plan to edit `cli.js` and want changes picked up automatically.

## Prerequisites

- **Node.js 18+**
- **ffmpeg** on PATH (`brew install ffmpeg` on macOS, `apt install ffmpeg` on Debian/Ubuntu)
- A working Chrome/Chromium that Puppeteer can launch. On macOS and x86_64 Linux this is automatic via the bundled download. On ARM64 Linux, set `PUPPETEER_EXECUTABLE_PATH` to a system-installed Chromium.

## Common usage

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

Run `h2v --help` for the full flag list, or see [docs/cli.md](docs/cli.md) for the same content with deeper context (presets, codecs, parallel recording, etc.).

## Demo & tests

- **[`demo/`](demo/)** — 12-animation Vaadin Swing Modernization Toolkit storyboard set up to exercise all three usage modes (single file / directory / bundle).
- **[`tests/`](tests/)** — minimal correctness fixtures, currently a single `sync-test.html` for verifying that the recorder keeps CSS- and JS-driven animations in lockstep.

## Uninstall / cleanup

To remove the global commands (whichever you installed with):

```
# If you used `npm install -g .`:
npm uninstall -g html-to-video

# If you used `npm link`:
cd /path/to/this/repo && npm unlink
# (from anywhere: `npm unlink -g html-to-video`)
```

To remove local artifacts:

```
rm -rf node_modules        # installed dependencies (~150 MB incl. Chromium download)
rm -rf output captures     # recording outputs and intermediate frames
```

All of `node_modules/`, `output/`, and `captures/` are gitignored.

> **Note:** if you used `npm link` and want to rename or move this directory, run `npm unlink` *before* the rename. The link is an absolute-path symlink, so renaming the directory leaves a broken symlink in your global npm bin. After the rename, run `npm link` again from the new path.
