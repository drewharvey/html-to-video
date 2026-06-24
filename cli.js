#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn, spawnSync } = require('child_process');

const PKG = require('./package.json');
const VERSION = PKG.version || '0.0.0';

const DEFAULTS = {
  fps: 60,
  // Stepped-down fps when --alpha is on. Alpha codecs (PNG-in-MOV,
  // ProRes 4444) are far larger per-frame than h264; halving the frame
  // rate halves the file size with no perceptual loss for compositing.
  alphaFps: 30,
  width: 1280,
  height: 720,
  scale: 3,
  crf: 18,
  duration: 10,
  slowdown: 6,
  outDir: 'output',
  // Capture frames as JPEG q=95 instead of PNG. JPEG q=95 is visually
  // lossless (PSNR ≈ 58 dB on the sync-test fixture and the demo
  // animations) and ~30% faster to encode at 4K. The downstream x264
  // CRF 18 step dominates the perceptual quality of the final MP4.
  captureFormat: 'jpeg',
  captureQuality: 95,
  // Default codec is libx264 → mp4 — the most compatible combination.
  // Other codecs and containers are opt-in.
  codec: 'libx264',
};

// Default output target: fit each frame within a 4K (UHD) box, orientation-
// aware — long edge ≤ 3840, short edge ≤ 2160. This is the default instead of
// a fixed device-scale-factor so that output is ~4K regardless of the authored
// viewport (h2v stays generic about canvas size; the "4K default" is honest
// for any input). For a 1280×720 page this is identical to the old scale-3
// default (× 3 = exactly 3840×2160). --scale (a density multiplier) and
// --output-height both override it. See computeRenderPlan.
const TARGET_4K_LONG = 3840;
const TARGET_4K_SHORT = 2160;

// Minimum frames a seek shard must hold to justify its own browser+page
// load (~0.4s) + font settle (~0.15s). Below this, splitting costs more in
// per-shard startup than it saves in parallel screenshots. Bounds the shard
// count in recordJobSharded: K = min(workers, floor(totalFrames / this)).
const SEEK_SHARD_MIN_FRAMES = 60;

const CAPTURE_FORMATS = new Set(['jpeg', 'png']);
const CAPTURE_EXT_FOR_FORMAT = { jpeg: 'jpg', png: 'png' };

const VIDEO_CODECS = new Set(['libx264', 'libx265', 'libvpx-vp9', 'prores_ks', 'qtrle', 'png', 'gif']);
const VIDEO_CONTAINERS = new Set(['mp4', 'mov', 'webm', 'gif']);

// GIF defaults (applied when --gif is set, unless overridden). GIFs are small
// web artifacts; 4K/60fps would be enormous and pointless, so --gif drops the
// resolution to a 480-tall target and the rate to 20fps unless
// --output-height/--scale or --fps say otherwise. 20 is chosen because GIF
// frame delays are quantized to centiseconds — 20fps = exactly 5cs/frame, so
// playback rate is exact; rates that don't divide 100 (e.g. 15 → 6.67cs) get
// rounded by the encoder and play slightly off.
const DEFAULT_GIF_HEIGHT = 480;
const DEFAULT_GIF_FPS = 20;

// Default container per codec, plus the full set of containers each
// codec is allowed to land in. ProRes outside .mov breaks most NLEs;
// VP9 outside .webm is fragile across players. PNG-in-MOV and qtrle are
// QuickTime-native lossless-with-alpha formats — neither is supported
// in mp4 or webm by any common player.
const DEFAULT_CONTAINER_FOR_CODEC = {
  libx264: 'mp4',
  libx265: 'mp4',
  'libvpx-vp9': 'webm',
  prores_ks: 'mov',
  qtrle: 'mov',
  png: 'mov',
  gif: 'gif',
};
const ALLOWED_CONTAINERS_FOR_CODEC = {
  libx264: new Set(['mp4', 'mov']),
  libx265: new Set(['mp4', 'mov']),
  'libvpx-vp9': new Set(['webm']),
  prores_ks: new Set(['mov']),
  qtrle: new Set(['mov']),
  png: new Set(['mov']),
  gif: new Set(['gif']),
};

// Quality presets bundle codec, capture-format, capture-quality, and CRF
// into named tiers. Codec-specific encoder choices (pix_fmt, x264 -preset,
// -tune, ProRes profile) are derived from the preset name in
// buildEncodeArgs — that's where the per-codec interpretation of "this
// tier" lives. Explicit user flags always override the preset's value
// for that field.
//
// `standard` is the default and matches today's no-flag behavior plus
// two always-on improvements that landed alongside the preset work
// (-tune animation for x264/x265 and -movflags +faststart for mp4/mov).
const QUALITY_PRESETS = {
  max: {
    captureFormat: 'png',
    codec: 'prores_ks',
    crf: 0,
    // captureQuality not applicable — PNG is lossless. CRF=0 is set so
    // that overriding --codec to libx264/libx265 still gets a "max tier"
    // lossless encode rather than defaulting back to CRF 18.
  },
  high: {
    captureFormat: 'jpeg',
    captureQuality: 100,
    codec: 'libx264',
    crf: 12,
  },
  standard: {
    captureFormat: 'jpeg',
    captureQuality: 95,
    codec: 'libx264',
    crf: 18,
  },
  draft: {
    captureFormat: 'jpeg',
    captureQuality: 80,
    codec: 'libx264',
    crf: 28,
  },
};
const QUALITY_PRESET_NAMES = Object.keys(QUALITY_PRESETS);

const SKIP_FILENAMES = new Set(['review.html']);

// Bundle marker syntax: ANIMATION_START / ANIMATION_END.
// We also accept the older FRAME_START / FRAME_END for backward
// compatibility with bundles authored before the rename.
const ANIMATION_BLOCK_RE =
  /<!--\s*=+\s*(?:ANIMATION|FRAME)_START\s+(.*?)\s*=+\s*-->\s*([\s\S]*?)\s*<!--\s*=+\s*(?:ANIMATION|FRAME)_END\b[^>]*?-->/g;
const ANIMATION_START_PROBE = /<!--\s*=+\s*(?:ANIMATION|FRAME)_START\b/;
const META_DURATION_RE =
  /<meta\s+name=["']h2v-duration["']\s+content=["']?(\d+(?:\.\d+)?)\s*s?["']?\s*\/?>/i;
const META_THEMES_RE =
  /<meta\s+name=["']h2v-themes["']\s+content=["']([^"']*)["']\s*\/?>/i;
const META_VIEWPORT_RE =
  /<meta\s+name=["']h2v-viewport["']\s+content=["']?(\d+)x(\d+)["']?\s*\/?>/i;
const VIEWPORT_ATTR_RE = /^(\d+)x(\d+)$/;
const DEFAULT_VIEWPORT = { w: 1280, h: 720 };
const THEME_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const ATTR_RE = /(\w+)="([^"]*)"/g;

// =========================================================================
// Help & version
// =========================================================================

const HELP_TEXT = `h2v v${VERSION} — convert HTML animations to video files

USAGE
  h2v export [<paths...>] [flags]   Render animations to video. Defaults to
                                    4K 60fps MP4 (h264); every output
                                    parameter is configurable.
  h2v review [<paths...>] [flags]   Build a single HTML page that previews
                                    every animation at the given paths.
  h2v bundle [<paths...>] [flags]   Assemble a list of standalone animation
                                    HTML files (and/or existing bundles)
                                    into a single bundle HTML file with
                                    ANIMATION_START / ANIMATION_END markers.
  h2v --help
  h2v --version

ARGUMENTS
  paths     One or more HTML files or directories. With no paths, every
            *.html in the current directory is processed (non-recursive).
            Files inside an explicitly named directory are filtered with
            the same rules: dotfiles and review.html are skipped.

EXPORT FLAGS
  --duration <Ns>     Capture duration. When passed explicitly, overrides
                      every per-file <meta name="h2v-duration"> and every
                      bundle marker's capture_duration. When omitted,
                      per-file metadata wins, then bundle marker, then the
                      default (${DEFAULTS.duration}s).
  --fps <N>           Frames per second (default: ${DEFAULTS.fps}; ${DEFAULTS.alphaFps} when --alpha
                      is set, since alpha output is much larger per-frame).
  --width <N>         Viewport width in CSS pixels. When omitted, per-file
                      <meta name="h2v-viewport"> or bundle marker viewport
                      attribute wins; default ${DEFAULTS.width}. Passing this flag
                      overrides every per-animation viewport for the run.
  --height <N>        Viewport height in CSS pixels. Same precedence as
                      --width; default ${DEFAULTS.height}. --width and --height are a
                      coupled pair — passing either makes both override
                      per-animation metas.
  --scale <N>         Density override: output = viewport × N (integer
                      device-scale-factor, no resampling). Replaces the
                      default 4K-fit target with a fixed multiplier — e.g.
                      --scale 1 to record at the authored size. Mutually
                      exclusive with --output-height.
  --output-height <N> Target output height in pixels (width follows the
                      animation's viewport aspect). h2v renders at the
                      smallest INTEGER scale that meets-or-exceeds N — kept
                      crisp, no fractional-scale aliasing — then Lanczos-
                      downscales the frames to exactly N (supersampling).
                      Overrides the default 4K-fit target to a specific
                      height (e.g. 1440). Must be even. Mutually exclusive
                      with --scale.

                      DEFAULT (neither --scale nor --output-height): fit
                      output within a 4K box (≤3840×2160, orientation-aware)
                      preserving aspect — so output is ~4K for any viewport.
                      A 1280×720 page → 3840×2160 (× 3); 1920×1080 → 3840×
                      2160 (× 2); 1600×900 → renders ×3, downscales to 4K.
  --quality-preset <name>
                      Bundled output-quality config. One of:
                        max       PNG capture + ProRes 4444 (12-bit 4:4:4)
                                  in .mov. Archival ceiling. Files are
                                  large; encode is slower.
                        high      JPEG q=100 + h264 yuv444p crf 12
                                  -preset veryslow -tune animation. Great
                                  fidelity; 4:4:4 trades hardware-decoder
                                  compatibility for chroma accuracy.
                        standard  JPEG q=95 + h264 yuv420p crf 18
                                  -preset medium -tune animation. The
                                  default; visually lossless, plays
                                  everywhere. (= h2v's no-flag behavior.)
                        draft     JPEG q=80 + h264 yuv420p crf 28
                                  -preset ultrafast. Fast iteration; tiny
                                  files; obvious compression artifacts.
                      Individual flags below override their preset values.
  --crf <N>           Quality knob (lower = bigger/better). Applies to
                      libx264, libx265, and libvpx-vp9. Ignored for
                      prores_ks (uses a fixed profile instead). Default
                      depends on --quality-preset.
  --codec <name>      Video encoder. One of: libx264, libx265,
                      libvpx-vp9, prores_ks, qtrle, png. h264 is the
                      universal default; h265 gives ~30% smaller files;
                      vp9 targets web delivery; prores_ks produces
                      editing-friendly masters; qtrle is lossless
                      QuickTime Animation (the --alpha default); png is
                      lossless PNG-in-MOV (alpha-capable but unreliable
                      in CapCut at 4K — see --alpha). Default depends on
                      --quality-preset and --alpha.
  --container <ext>   Output container: mp4, mov, or webm. Auto-derived
                      from --codec when omitted (h264/h265 → mp4, vp9 →
                      webm, prores → mov). Set explicitly to override
                      (e.g. h264 in .mov for older NLE compatibility).
                      Incompatible codec/container combos error.
  --capture-format <fmt>
                      Frame-capture format: jpeg (default) or png. PNG is
                      lossless but ~30% slower at 4K; useful when feeding
                      frames into other tooling. Mutually exclusive with
                      --capture-quality.
  --capture-quality <N>
                      JPEG quality 1-100 (default: ${DEFAULTS.captureQuality}). Lower for faster
                      iteration; raise toward 100 for archival. JPEG only.
  --alpha             Record with a transparent background. Output is
                      qtrle-in-MOV (QuickTime Animation) with pre-
                      multiplied alpha by default — lossless, native
                      Apple codec, renders correctly in CapCut, Premiere,
                      Resolve, FCP, AE at 4K and long durations. Steps
                      --fps down to ${DEFAULTS.alphaFps} unless --fps is passed explicitly
                      (alpha output is much larger per-frame than h264).
                      The page must not paint an opaque html/body
                      background — see docs/authoring.md.

                      Codec alternatives:

                        --alpha --codec prores_ks
                            ProRes 4444 (yuva444p10le, 10-bit). Apple
                            colour-managed mastering pipelines. Larger
                            files (~5-10× qtrle). Same pre-multiplied
                            alpha behaviour.

                        --alpha --codec png
                            PNG-in-MOV. Bit-exact lossless, smallest
                            files. NOT recommended for CapCut — its PNG
                            decoder drops alpha at 4K + long durations,
                            producing solid-white backgrounds. Works
                            cleanly in QuickTime, IINA, FCP, web.

                      Forces --capture-format png. Errors if a
                      conflicting flag is set explicitly.

  --alpha-mode <m>    Alpha interpretation: 'premultiplied' (default,
                      RGB×α baked into the file — matches what CapCut,
                      Resolve, Premiere, AE and most video tools expect
                      for compositing intermediates) or 'straight' (RGB
                      stored at full strength — needed only for the rare
                      tool that explicitly wants straight alpha; will
                      cause white-halo / blown-out semi-transparent
                      regions in CapCut and similar editors). Requires
                      --alpha.
  --gif               Export an animated GIF instead of a video. Forces the
                      .gif container and a single-pass palette encode, and
                      applies GIF defaults: ${DEFAULT_GIF_HEIGHT}p output and ${DEFAULT_GIF_FPS}fps (override
                      with --output-height / --scale and --fps). Quality
                      (palette + dithering) comes from --quality-preset:
                      max = per-frame palette; high = global palette, fine
                      dither; standard = global + bayer dither (default);
                      draft = 128 colours, no dither. GIF is 256-colour with
                      no gradients/alpha — best for short, flat UI clips; for
                      web, mp4/webm is smaller. Mutually exclusive with
                      --alpha and --codec/--container.
  --slowdown <N>      Real-time slowdown factor (default: ${DEFAULTS.slowdown}). The browser
                      runs animations at 1/N speed so screenshots can keep
                      up; the resulting video plays back at original speed.
                      Total recording wall time = animation duration × N.
                      Use 1 to disable (only works if screenshots fit in
                      one frame interval, ~16 ms at 60 fps).
  --theme <spec>      Which theme(s) to record. The page declares its
                      themes via <meta name="h2v-themes" content="a,b,c">
                      (single-file) or themes="a,b,c" on bundle markers.
                      Spec forms:
                        <name>       record this one (must be declared)
                        a,b,c        record this comma list
                        all          record every declared theme
                      With no flag, records the default theme (first
                      declared, or no theme handling for unthemed pages).
                      Default theme has no filename suffix; non-default
                      themes are written as <name>-<theme>.<ext>, where
                      <ext> follows --container.
  --concurrency <N>   How many browsers to record with in parallel (default
                      1). Each slot launches its own browser, so memory
                      scales linearly. For a batch (2+ jobs), jobs run in
                      parallel. For a SINGLE animation, a seek-driven job is
                      frame-sharded — its frames split across the slots — for
                      a near-linear speedup; play (slowdown) and very short
                      jobs stay on one browser. Suggested:
                      3 on 8 GB, 8 on 16 GB, 12 on 32 GB+ (CPU cores cap
                      effective parallelism past ~12 on most machines).
                      h2v prints a (rough) warning if it estimates the
                      run will exceed available memory; it doesn't block.
  --out-dir <path>    Output directory (default: ./${DEFAULTS.outDir}).
  --out <path>        Exact output filename. Only valid when exactly one
                      video file will be produced. The extension must
                      match --container.
  --no-ffmpeg         Skip the encode step. Captured frames stay in
                      ./captures/ (no cleanup); --capture-format decides
                      whether they're JPEG or PNG.
  --dry-run           Print the recording plan and exit (no browser needed).
  --paste             Read HTML from the terminal (or piped stdin) instead
                      of from a file path. Interactive: paste with Ctrl+V,
                      then press Enter to start. Pipe: pbpaste | h2v export
                      --paste, or h2v export --paste < bundle.html. Output
                      lands in output/paste/<id>.<ext> for bundles or
                      output/paste.<ext> for single-file. Cannot be
                      combined with positional path arguments.

REVIEW FLAGS
  --out <path>        Write the review page to this path instead of a
                      tmpfile (implies --keep). Inlines each animation
                      into the page (srcdoc) so the saved file is
                      portable. Without --out, single-file animations
                      are loaded via file:// URLs so a browser refresh
                      picks up edits to the source files.
  --no-open           Don't auto-open the browser; just print the path.
                      (No auto-cleanup either.)
  --keep              Don't delete the temp file on exit. (Implied by
                      --out and --no-open.)
  --paste             Read HTML from the terminal (or piped stdin) instead
                      of from a file path. Same semantics as the export
                      flag of the same name; cannot be combined with
                      positional path arguments.

BUNDLE FLAGS
  --out <path>        Write the bundle to this path. Defaults to
                      output/<dirname>.html when the single positional arg
                      is a directory (e.g. \`h2v bundle anims/\` →
                      output/anims.html), otherwise output/bundle.html.

  Per-animation metadata is read from each input's <meta name="h2v-..."> tags
  (duration, viewport, themes) and propagated to marker attributes.
  Animation id is derived from filename basename. Input files that already
  contain ANIMATION_START markers are decomposed and merged; this lets you
  combine existing bundles with new standalone clips in one command.
  Duplicate ids (after collection) are an error.

SHARED FLAGS
  -h, --help          Show this help.
  --version           Show version.

PER-FILE METADATA
  Add <meta name="h2v-duration" content="Ns"> in the <head> of a
  single-file animation to set its capture duration. The value is in
  seconds and may be an integer or a decimal.

  Add <meta name="h2v-themes" content="dark,light,..."> to opt into
  multi-theme recording. h2v sets data-theme="<name>" on <html> after
  navigation for any non-default theme; your CSS reacts via
  [data-theme="<name>"] selectors. The first listed theme is the
  default (no attribute set, no filename suffix).

  Add <meta name="h2v-viewport" content="WxH"> to declare the design
  viewport (e.g., 1280x720, 1080x1080, 720x1280). Used by both h2v
  export (per-animation recording size) and h2v review (per-iframe
  sizing on the preview page). The CLI's --width / --height flags
  override it for ad-hoc runs. Default: 1280x720.

ENVIRONMENT
  PUPPETEER_EXECUTABLE_PATH  Browser executable path. Useful when
                             puppeteer's bundled Chrome isn't compatible
                             with the host (e.g. ARM64 Linux).
`;

function printHelp() {
  process.stdout.write(HELP_TEXT);
}

// =========================================================================
// Argument parsing
// =========================================================================

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }
  if (args[0] === '--version') {
    console.log(VERSION);
    process.exit(0);
  }

  const [command, ...rest] = args;
  if (command !== 'export' && command !== 'review' && command !== 'bundle') {
    console.error(`error: unknown command: ${command}`);
    console.error(`Did you mean: h2v export ${args.join(' ')} ?`);
    process.exit(2);
  }

  const positional = [];
  const opts = {
    command,
    duration: DEFAULTS.duration,
    durationExplicit: false,
    fps: DEFAULTS.fps,
    fpsExplicit: false,
    width: DEFAULTS.width,
    height: DEFAULTS.height,
    scale: DEFAULTS.scale,
    scaleExplicit: false,
    outputHeight: null,
    crf: DEFAULTS.crf,
    slowdown: DEFAULTS.slowdown,
    themeSpec: null,
    concurrency: 1,
    outDir: DEFAULTS.outDir,
    outOverride: null,
    captureFormat: DEFAULTS.captureFormat,
    captureQuality: DEFAULTS.captureQuality,
    captureQualityExplicit: false,
    captureFormatExplicit: false,
    codec: DEFAULTS.codec,
    codecExplicit: false,
    crfExplicit: false,
    widthExplicit: false,
    heightExplicit: false,
    container: null,
    qualityPreset: 'standard',
    alpha: false,
    alphaMode: 'premultiplied',
    alphaModeExplicit: false,
    gif: false,
    skipFfmpeg: false,
    dryRun: false,
    skipOpen: false,
    keep: false,
    paste: false,
  };

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const requireValue = (label) => {
      const v = rest[++i];
      if (v === undefined) {
        console.error(`error: ${label} requires a value`);
        process.exit(2);
      }
      return v;
    };
    if (a === '--duration') {
      opts.duration = parseDurationFlag(requireValue('--duration'));
      opts.durationExplicit = true;
    }
    else if (a === '--fps') {
      opts.fps = parsePositiveInt(requireValue('--fps'), '--fps');
      opts.fpsExplicit = true;
    }
    else if (a === '--width') {
      opts.width = parsePositiveInt(requireValue('--width'), '--width');
      opts.widthExplicit = true;
    }
    else if (a === '--height') {
      opts.height = parsePositiveInt(requireValue('--height'), '--height');
      opts.heightExplicit = true;
    }
    else if (a === '--scale') {
      opts.scale = parsePositiveInt(requireValue('--scale'), '--scale');
      opts.scaleExplicit = true;
    }
    else if (a === '--output-height') {
      opts.outputHeight = parsePositiveInt(requireValue('--output-height'), '--output-height');
    }
    else if (a === '--crf') {
      opts.crf = parseIntInRange(requireValue('--crf'), '--crf', 0, 51);
      opts.crfExplicit = true;
    }
    else if (a === '--slowdown') opts.slowdown = parsePositiveInt(requireValue('--slowdown'), '--slowdown');
    else if (a === '--theme') opts.themeSpec = parseThemeFlag(requireValue('--theme'));
    else if (a === '--concurrency') opts.concurrency = parsePositiveInt(requireValue('--concurrency'), '--concurrency');
    else if (a === '--out-dir') opts.outDir = requireValue('--out-dir');
    else if (a === '--out') opts.outOverride = requireValue('--out');
    else if (a === '--capture-format') {
      opts.captureFormat = parseCaptureFormat(requireValue('--capture-format'));
      opts.captureFormatExplicit = true;
    }
    else if (a === '--capture-quality') {
      opts.captureQuality = parseIntInRange(requireValue('--capture-quality'), '--capture-quality', 1, 100);
      opts.captureQualityExplicit = true;
    }
    else if (a === '--codec') {
      opts.codec = parseCodec(requireValue('--codec'));
      opts.codecExplicit = true;
    }
    else if (a === '--container') opts.container = parseContainer(requireValue('--container'));
    else if (a === '--quality-preset') opts.qualityPreset = parseQualityPreset(requireValue('--quality-preset'));
    else if (a === '--alpha') opts.alpha = true;
    else if (a === '--gif') opts.gif = true;
    else if (a === '--alpha-mode') {
      const v = requireValue('--alpha-mode');
      if (v !== 'straight' && v !== 'premultiplied') {
        console.error(`error: --alpha-mode must be 'straight' or 'premultiplied' (got '${v}')`);
        process.exit(2);
      }
      opts.alphaMode = v;
      opts.alphaModeExplicit = true;
    }
    else if (a === '--no-ffmpeg') opts.skipFfmpeg = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-open') opts.skipOpen = true;
    else if (a === '--paste') opts.paste = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a.startsWith('-')) {
      console.error(`error: unknown flag: ${a}`);
      process.exit(2);
    } else {
      positional.push(a);
    }
  }

  return { paths: positional, opts };
}

function parseDurationFlag(s) {
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*s?$/i);
  if (!m) {
    console.error(`error: invalid duration: ${s}`);
    process.exit(2);
  }
  const n = parseFloat(m[1]);
  if (n <= 0) {
    console.error(`error: duration must be > 0`);
    process.exit(2);
  }
  return n;
}

function parsePositiveInt(s, label) {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`error: ${label} must be a positive integer (got: ${s})`);
    process.exit(2);
  }
  return n;
}

function parseIntInRange(s, label, min, max) {
  const n = Number(s);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`error: ${label} must be an integer in [${min}..${max}] (got: ${s})`);
    process.exit(2);
  }
  return n;
}

function parseCaptureFormat(s) {
  const v = String(s).toLowerCase();
  if (!CAPTURE_FORMATS.has(v)) {
    console.error(`error: --capture-format must be one of: ${[...CAPTURE_FORMATS].join(', ')} (got: ${s})`);
    process.exit(2);
  }
  return v;
}

function parseCodec(s) {
  const v = String(s);
  if (!VIDEO_CODECS.has(v)) {
    console.error(`error: --codec must be one of: ${[...VIDEO_CODECS].join(', ')} (got: ${s})`);
    process.exit(2);
  }
  return v;
}

function parseContainer(s) {
  const v = String(s).toLowerCase();
  if (!VIDEO_CONTAINERS.has(v)) {
    console.error(`error: --container must be one of: ${[...VIDEO_CONTAINERS].join(', ')} (got: ${s})`);
    process.exit(2);
  }
  return v;
}

function parseQualityPreset(s) {
  const v = String(s).toLowerCase();
  if (!QUALITY_PRESETS[v]) {
    console.error(`error: --quality-preset must be one of: ${QUALITY_PRESET_NAMES.join(', ')} (got: ${s})`);
    process.exit(2);
  }
  return v;
}

// Resolve and validate codec/container/capture flags after parsing.
// Mutates opts in place (applies the quality preset, then validates).
// Explicit user flags always override the preset for that field.
// Exits with a clear error on incompatible combos.
function resolveExportOpts(opts) {
  const preset = QUALITY_PRESETS[opts.qualityPreset];
  if (!opts.captureFormatExplicit && preset.captureFormat != null) {
    opts.captureFormat = preset.captureFormat;
  }
  if (!opts.captureQualityExplicit && preset.captureQuality != null) {
    opts.captureQuality = preset.captureQuality;
  }
  if (!opts.codecExplicit && preset.codec != null) {
    opts.codec = preset.codec;
  }
  if (!opts.crfExplicit && preset.crf != null) {
    opts.crf = preset.crf;
  }

  // --gif is a cross-cutting mode flag (like --alpha): it forces the gif
  // codec + .gif container and applies GIF-appropriate defaults. Resolved
  // here, before the codec/container compatibility check, so the forced
  // values participate in that validation. `--codec gif` is treated
  // identically. GIF quality (palette + dither) is derived from
  // --quality-preset inside ffmpegStitch — no separate gif-quality flag; the
  // preset's codec/crf are irrelevant to gif and ignored (like qtrle/png
  // ignore crf), while its captureFormat still applies (so the `max` tier's
  // PNG capture feeds a cleaner palette).
  if (opts.gif) {
    if (opts.codecExplicit && opts.codec !== 'gif') {
      console.error(
        `error: --gif cannot be combined with --codec ${opts.codec} ` +
        `(--gif forces the gif codec). Drop one.`
      );
      process.exit(2);
    }
    opts.codec = 'gif';
  }
  if (opts.codec === 'gif') {
    opts.gif = true;
    if (opts.alpha) {
      console.error(
        'error: --gif and --alpha are mutually exclusive (GIF has only 1-bit ' +
        'transparency, not a compositing alpha channel).'
      );
      process.exit(2);
    }
    if (opts.container != null && opts.container !== 'gif') {
      console.error(
        `error: --gif forces the .gif container (got --container ${opts.container}).`
      );
      process.exit(2);
    }
    opts.container = 'gif';
    // GIF-appropriate defaults: low fps + modest resolution, unless the user
    // asked for specific ones.
    if (!opts.fpsExplicit) opts.fps = DEFAULT_GIF_FPS;
    if (!opts.scaleExplicit && opts.outputHeight == null) {
      opts.outputHeight = DEFAULT_GIF_HEIGHT;
    }
  }

  // --alpha is a cross-cutting flag that constrains codec, container, and
  // capture format. Resolve it before the codec/container compatibility
  // check below so its overrides participate in that validation.
  //
  // Default alpha codec is `qtrle` (QuickTime Animation, RLE-lossless):
  // bit-exact lossless, file size comparable to PNG-in-MOV, and — most
  // importantly — decodes correctly in CapCut at 4K and long durations.
  // That last property is what landed us here. Earlier defaults didn't
  // survive a full-matrix test against a real-world 4K 17s clip:
  //
  //   • `prores_ks` (the original default) — ffmpeg's prores_ks muxer
  //     ships without an explicit alpha-mode metadata tag, so players
  //     guess; QuickTime/FCP guessed straight (correct for our straight
  //     output), CapCut guessed pre-multiplied (wrong → bright halos).
  //   • `png` (the second default, with `-vf premultiply=inplace=1`)
  //     fixed the short-clip CapCut test, but CapCut's PNG-codec
  //     decoder failed on alpha at 4K + long duration regardless of
  //     alpha mode — backgrounds rendered solid white. PNG-in-MOV
  //     still works for IINA, QuickTime, FCP, some web flows, so it
  //     remains opt-in via `--codec png`.
  //   • `qtrle` + pre-multiplied alpha (current default) — passed the
  //     same 4K 17s CapCut test on the first try, plus the existing
  //     QuickTime/FCP/Resolve/Premiere expectations.
  //
  // `prores_ks` remains opt-in for Apple colour-managed workflows that
  // demand 10-bit chroma. Other codecs are rejected: libx264/libx265
  // have no alpha; libvpx-vp9 silently drops the alpha plane in
  // ffmpeg's single-call invocation (verified empirically).
  if (opts.alpha) {
    if (!opts.codecExplicit) {
      opts.codec = 'qtrle';
    } else if (opts.codec !== 'qtrle' && opts.codec !== 'png' && opts.codec !== 'prores_ks') {
      console.error(
        `error: --alpha supports --codec qtrle (default), --codec png, or --codec prores_ks ` +
        `(got --codec ${opts.codec}). Omit --codec to use the default.`
      );
      process.exit(2);
    }
    if (!opts.captureFormatExplicit) {
      opts.captureFormat = 'png';
    } else if (opts.captureFormat !== 'png') {
      console.error(
        'error: --alpha requires --capture-format png ' +
        '(JPEG cannot carry an alpha channel). Omit --capture-format to let --alpha pick it.'
      );
      process.exit(2);
    }
    // Step fps down to DEFAULTS.alphaFps (30) by default for --alpha.
    // Alpha output (PNG-in-MOV or ProRes 4444) is much larger per-frame
    // than h264 — at 60fps the file sizes get unwieldy fast (tens of MB
    // per second). 30fps is perceptually clean for compositing work and
    // halves the file size. Users who want 60fps alpha can pass --fps 60
    // explicitly.
    if (!opts.fpsExplicit) {
      opts.fps = DEFAULTS.alphaFps;
    }
  } else if (opts.alphaModeExplicit) {
    // --alpha-mode is only meaningful with --alpha; catch the mistake
    // rather than silently ignoring it.
    console.error('error: --alpha-mode requires --alpha to be set');
    process.exit(2);
  }

  if (opts.captureFormat === 'png' && opts.captureQualityExplicit) {
    console.error('error: --capture-quality only applies to JPEG capture; remove it or use --capture-format jpeg');
    process.exit(2);
  }

  const allowedContainers = ALLOWED_CONTAINERS_FOR_CODEC[opts.codec];
  if (opts.container == null) {
    opts.container = DEFAULT_CONTAINER_FOR_CODEC[opts.codec];
  } else if (!allowedContainers.has(opts.container)) {
    const allowed = [...allowedContainers].join(', ');
    console.error(
      `error: codec ${opts.codec} cannot be packaged in .${opts.container} (allowed: ${allowed})`
    );
    process.exit(2);
  }

  if (opts.outOverride) {
    const ext = path.extname(opts.outOverride).slice(1).toLowerCase();
    if (ext && ext !== opts.container) {
      console.error(
        `error: --out extension .${ext} doesn't match container .${opts.container}. ` +
        `Either rename the output or pass --container ${ext} (if codec ${opts.codec} allows it).`
      );
      process.exit(2);
    }
  }

  // --output-height: supersampled target resolution. h2v renders at an
  // integer device-scale-factor that meets-or-exceeds the target height
  // (kept crisp — no fractional DSF aliasing), then ffmpeg downscales the
  // captured frames to the exact height with a Lanczos filter. The per-job
  // integer render scale is computed in makeJob; the downscale is applied in
  // ffmpegStitch. Width follows each animation's viewport aspect.
  if (opts.outputHeight != null) {
    // It's an alternative to --scale (it derives the render scale), so
    // taking both is contradictory.
    if (opts.scaleExplicit) {
      console.error(
        'error: --output-height and --scale are mutually exclusive. --output-height ' +
        'derives the render scale automatically; pass one or the other.'
      );
      process.exit(2);
    }
    // Must be even: the default yuv420p encode (and most subsampled
    // pix_fmts) require even dimensions. Width is forced even by the
    // downscale filter (scale=-2:H); height is the user's value.
    if (opts.outputHeight % 2 !== 0) {
      console.error(
        `error: --output-height must be even (got ${opts.outputHeight}); ` +
        `video encoders require even dimensions. Try ${opts.outputHeight - 1}.`
      );
      process.exit(2);
    }
  }
}

function parseThemeFlag(s) {
  const trimmed = String(s).trim();
  if (trimmed === 'all') return 'all';
  const names = trimmed.split(',').map((t) => t.trim()).filter(Boolean);
  if (names.length === 0) {
    console.error(`error: --theme value cannot be empty`);
    process.exit(2);
  }
  for (const t of names) {
    if (!THEME_NAME_RE.test(t)) {
      console.error(
        `error: invalid theme name: "${t}" (allowed: letters, digits, '-', '_')`
      );
      process.exit(2);
    }
  }
  return names;
}

// =========================================================================
// Input discovery
// =========================================================================

function discoverInputs(paths, cwd) {
  const inputs = new Set();
  if (paths.length === 0) {
    listHtmlInDir(cwd).forEach((p) => inputs.add(p));
    return [...inputs].sort();
  }
  for (const arg of paths) {
    const abs = path.resolve(cwd, arg);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (err) {
      console.error(`error: path not found: ${arg}`);
      process.exit(1);
    }
    if (stat.isFile()) {
      if (!abs.toLowerCase().endsWith('.html')) {
        console.error(`error: not an HTML file: ${arg}`);
        process.exit(1);
      }
      inputs.add(abs);
    } else if (stat.isDirectory()) {
      listHtmlInDir(abs).forEach((p) => inputs.add(p));
    } else {
      console.error(`error: not a file or directory: ${arg}`);
      process.exit(1);
    }
  }
  return [...inputs].sort();
}

function listHtmlInDir(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    if (SKIP_FILENAMES.has(entry)) continue;
    if (!entry.toLowerCase().endsWith('.html')) continue;
    const abs = path.resolve(dir, entry);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.isFile()) out.push(abs);
  }
  return out;
}

// =========================================================================
// Mode detection & parsing
// =========================================================================

function detectMode(htmlText) {
  return ANIMATION_START_PROBE.test(htmlText) ? 'bundle' : 'single';
}

function parseAttributes(attrString) {
  const out = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrString)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

function parseBundleFrames(htmlText, sourcePath) {
  const frames = [];
  let m;
  ANIMATION_BLOCK_RE.lastIndex = 0;
  while ((m = ANIMATION_BLOCK_RE.exec(htmlText)) !== null) {
    const attrs = parseAttributes(m[1]);
    if (!attrs.id) {
      throw new Error(`${sourcePath}: ANIMATION_START without id attribute`);
    }
    if (!attrs.capture_duration) {
      throw new Error(`${sourcePath}: ANIMATION_START id="${attrs.id}" missing capture_duration`);
    }
    const durMatch = attrs.capture_duration.match(/^(\d+(?:\.\d+)?)s?$/i);
    if (!durMatch) {
      throw new Error(`${sourcePath}: ANIMATION_START id="${attrs.id}" has invalid capture_duration "${attrs.capture_duration}"`);
    }
    let viewport = null;
    if (attrs.viewport) {
      const vMatch = attrs.viewport.match(VIEWPORT_ATTR_RE);
      if (!vMatch) {
        throw new Error(`${sourcePath}: ANIMATION_START id="${attrs.id}" has invalid viewport "${attrs.viewport}" (expected WxH, e.g. 1280x720)`);
      }
      viewport = { w: parseInt(vMatch[1], 10), h: parseInt(vMatch[2], 10) };
    }
    frames.push({
      id: attrs.id,
      title: attrs.title || attrs.id,
      durationSeconds: parseFloat(durMatch[1]),
      html: m[2],
      declaredThemes: parseThemeList(attrs.themes || ''),
      viewport,
    });
  }
  if (frames.length === 0) {
    throw new Error(`${sourcePath}: bundle marker found but no complete ANIMATION_START/ANIMATION_END pair`);
  }
  return frames;
}

function extractMetaDuration(htmlText) {
  const m = htmlText.match(META_DURATION_RE);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n > 0 ? n : null;
}

function extractDeclaredThemes(htmlText) {
  const m = htmlText.match(META_THEMES_RE);
  if (!m) return [];
  return parseThemeList(m[1]);
}

// Parse <meta name="h2v-viewport" content="WxH"> from a single-file
// animation. Returns {w, h} of positive integers, or null if absent
// or malformed. Callers default to DEFAULT_VIEWPORT.
function extractViewport(htmlText) {
  const m = htmlText.match(META_VIEWPORT_RE);
  if (!m) return null;
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (w > 0 && h > 0) return { w, h };
  return null;
}

function parseThemeList(s) {
  const names = String(s).split(',').map((t) => t.trim()).filter(Boolean);
  // Dedupe while preserving order.
  return [...new Set(names)];
}

// Returns the theme names to record for a given animation. Each entry is
// either a string (set data-theme="<name>") or null (don't set the
// attribute and use no filename suffix). The first declared theme is the
// "default" — recording it normalizes to null.
function deriveThemes(declaredThemes, themeSpec, label) {
  const defaultTheme = declaredThemes.length > 0 ? declaredThemes[0] : null;
  const normalize = (t) => (t === defaultTheme ? null : t);

  // No flag: just the default (or null for unthemed pages).
  if (themeSpec == null) return [null];

  // --theme all: every declared theme; unthemed pages produce one MP4.
  if (themeSpec === 'all') {
    if (declaredThemes.length === 0) return [null];
    return declaredThemes.map(normalize);
  }

  // Explicit name list: every requested theme must be declared.
  const missing = themeSpec.filter((t) => !declaredThemes.includes(t));
  if (missing.length > 0) {
    if (declaredThemes.length === 0) {
      throw new Error(
        `${label}: --theme ${themeSpec.join(',')} requested but page declares no h2v-themes`
      );
    }
    throw new Error(
      `${label}: theme(s) not declared: ${missing.join(',')} (declared: ${declaredThemes.join(',')})`
    );
  }
  return themeSpec.map(normalize);
}

// =========================================================================
// Plan construction
// =========================================================================

function buildPlan(inputs, opts) {
  const jobs = [];
  // If either --width or --height was passed explicitly, the CLI flag pair
  // overrides any per-animation viewport meta/marker for the whole run.
  // Mixing CLI width with meta height (or vice versa) would be confusing,
  // so we treat them as a coupled override.
  const flagViewportOverrides = opts.widthExplicit || opts.heightExplicit;
  for (const inputPath of inputs) {
    const text = fs.readFileSync(inputPath, 'utf8');
    const mode = detectMode(text);
    const inputBase = path.basename(inputPath, path.extname(inputPath));

    if (mode === 'bundle') {
      const frames = parseBundleFrames(text, inputPath);
      for (const frame of frames) {
        const themes = deriveThemes(
          frame.declaredThemes,
          opts.themeSpec,
          `${relativeToHere(inputPath)} (${frame.id})`
        );
        const durationSeconds = opts.durationExplicit ? opts.duration : frame.durationSeconds;
        const durationSource = opts.durationExplicit ? 'flag' : 'marker';
        const viewport = flagViewportOverrides
          ? { w: opts.width, h: opts.height }
          : (frame.viewport || DEFAULT_VIEWPORT);
        for (const theme of themes) {
          jobs.push(makeJob({
            inputPath, inputBase,
            mode: 'bundle',
            bundleId: frame.id,
            bundleTitle: frame.title,
            bundleHtml: frame.html,
            durationSeconds,
            durationSource,
            width: viewport.w,
            height: viewport.h,
            theme,
          }, opts));
        }
      }
    } else {
      const meta = extractMetaDuration(text);
      const declaredThemes = extractDeclaredThemes(text);
      const viewportMeta = extractViewport(text);
      const durationSeconds = opts.durationExplicit
        ? opts.duration
        : (meta != null ? meta : opts.duration);
      const durationSource = opts.durationExplicit
        ? 'flag'
        : (meta != null ? 'meta' : 'default');
      const viewport = flagViewportOverrides
        ? { w: opts.width, h: opts.height }
        : (viewportMeta || DEFAULT_VIEWPORT);
      const themes = deriveThemes(
        declaredThemes,
        opts.themeSpec,
        relativeToHere(inputPath)
      );
      for (const theme of themes) {
        jobs.push(makeJob({
          inputPath, inputBase,
          mode: 'single',
          bundleId: null,
          bundleTitle: null,
          bundleHtml: null,
          durationSeconds,
          durationSource,
          width: viewport.w,
          height: viewport.h,
          theme,
        }, opts));
      }
    }
  }
  return jobs;
}

// Determine the capture (render) device-scale-factor and the optional
// downscale target height for one animation, given its viewport. Three modes:
//   --scale N (explicit) → density: render at integer N, no downscale.
//   --output-height N    → render at the smallest integer ≥ N/height, then
//                          downscale to height N (width follows the aspect).
//   default (neither)    → fit within a 4K box (orientation-aware): render at
//                          the smallest integer ≥ the fit ratio, downscale to
//                          the fitted size.
// In every mode the render scale is an INTEGER (crisp raster, no fractional-
// DSF aliasing) and we only ever downscale (supersample), never upscale.
// Returns { renderScale, outputHeight }; outputHeight is null in density mode,
// and equals the render height (downscale skipped) on exact integer fits.
function computeRenderPlan(width, height, opts) {
  if (opts.scaleExplicit) {
    return { renderScale: opts.scale, outputHeight: null };
  }
  if (opts.outputHeight != null) {
    return {
      renderScale: Math.max(1, Math.ceil(opts.outputHeight / height)),
      outputHeight: opts.outputHeight,
    };
  }
  // Default: fit within the 4K box, preserving aspect ratio and orientation.
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  const fit = Math.min(TARGET_4K_LONG / longSide, TARGET_4K_SHORT / shortSide);
  const renderScale = Math.max(1, Math.ceil(fit));
  const renderHeight = height * renderScale;
  // Even output height (encoders need it; ffmpeg's scale=-2 evens the width),
  // clamped to never exceed the render height (downscale-only).
  let outputHeight = 2 * Math.round((height * fit) / 2);
  if (outputHeight > renderHeight) outputHeight = 2 * Math.floor(renderHeight / 2);
  if (outputHeight < 2) outputHeight = 2;
  return { renderScale, outputHeight };
}

function makeJob(j, opts) {
  const totalFrames = Math.max(1, Math.round(j.durationSeconds * opts.fps));
  const themeSuffix = j.theme ? '-' + j.theme : '';
  const captureKey = j.mode === 'bundle'
    ? `${j.inputBase}__${j.bundleId}${themeSuffix}`
    : `${j.inputBase}${themeSuffix}`;
  const { renderScale, outputHeight } = computeRenderPlan(j.width, j.height, opts);
  return {
    ...j,
    totalFrames,
    renderScale,
    outputHeight,
    captureKey,
    label: j.mode === 'bundle'
      ? `[${j.inputBase}:${j.bundleId}${j.theme ? ' ' + j.theme : ''}]`
      : `[${j.inputBase}${j.theme ? ' ' + j.theme : ''}]`,
  };
}

function outputPathFor(job, opts) {
  const cwd = process.cwd();
  if (opts.outOverride) {
    return path.resolve(cwd, opts.outOverride);
  }
  const outDir = path.resolve(cwd, opts.outDir);
  const themeSuffix = job.theme ? '-' + job.theme : '';
  const ext = opts.container;
  if (job.mode === 'bundle') {
    return path.join(outDir, job.inputBase, `${job.bundleId}${themeSuffix}.${ext}`);
  }
  return path.join(outDir, `${job.inputBase}${themeSuffix}.${ext}`);
}

function validatePlan(jobs, opts) {
  if (opts.outOverride && jobs.length !== 1) {
    console.error(
      `error: --out can only be used when exactly one MP4 will be produced (this run produces ${jobs.length})`
    );
    process.exit(2);
  }
  // Detect duplicate output paths (could happen with same basename in different dirs).
  const seen = new Map();
  for (const job of jobs) {
    const out = outputPathFor(job, opts);
    if (seen.has(out)) {
      console.error(
        `error: two animations would write to the same output path: ${out}`
      );
      console.error(`  - ${seen.get(out)}`);
      console.error(`  - ${job.inputPath}${job.bundleId ? ` (${job.bundleId})` : ''}`);
      process.exit(1);
    }
    seen.set(out, `${job.inputPath}${job.bundleId ? ` (${job.bundleId})` : ''}`);
  }
}

// =========================================================================
// Plan summary
// =========================================================================

function relativeToHere(p) {
  const r = path.relative(process.cwd(), p);
  return r.startsWith('..') ? p : r;
}

function printPlan(jobs, opts) {
  if (jobs.length === 0) {
    console.log('No animations to record.');
    return;
  }
  const totalFrames = jobs.reduce((s, j) => s + j.totalFrames, 0);
  const totalSeconds = jobs.reduce((s, j) => s + j.durationSeconds, 0);
  // Annotate per-job rows with [WxH] only when jobs have varied resolutions;
  // otherwise the global summary line carries that info.
  const sizes = new Set(jobs.map((j) => `${j.width}x${j.height}`));
  const variedSizes = sizes.size > 1;
  console.log(
    `Plan: ${jobs.length} animation${jobs.length === 1 ? '' : 's'}, ` +
    `${totalFrames} frames at ${opts.fps}fps (~${totalSeconds.toFixed(1)}s of footage)`
  );
  for (const job of jobs) {
    const out = relativeToHere(outputPathFor(job, opts));
    const dur = `${job.durationSeconds}s`;
    const src =
      job.durationSource === 'flag' ? ' (--duration override)' :
      job.durationSource === 'meta' ? ' (from meta tag)' :
      '';
    const sizeAnnotation = variedSizes ? ` [${job.width}×${job.height}]` : '';
    console.log(
      `  ${job.label.padEnd(34)} ${dur.padStart(6)} × ${opts.fps}fps = ` +
      `${String(job.totalFrames).padStart(5)} frames${sizeAnnotation} → ${out}${src}`
    );
  }
}

// =========================================================================
// Time slowdown for synchronized JS + CSS animation capture
// =========================================================================
//
// Goal: capture N frames per second of an animation that "should" play at
// real-time speed. Screenshots are slow (4K PNGs take ~150 ms each), so we
// can't capture at the target framerate in real time without missing
// frames. The fix: slow EVERYTHING in the page by a factor S.
//
// 1. JS time sources are wrapped before any page script runs:
//    - `setTimeout`/`setInterval` delays are multiplied by S
//    - `performance.now()` returns "real elapsed since page load" / S
//    - `Date.now()` returns "page-load epoch + (real elapsed since page
//       load) / S"
//    - `requestAnimationFrame` callback timestamps are slowed indirectly:
//       Chrome reads the (overridden) `performance.now` when generating
//       the timestamp argument, so wrapping rAF explicitly would
//       double-slow it. See the SHIM_SOURCE comment below.
//
// 2. CSS animations and transitions are slowed via the CDP Animation
//    domain: `Animation.setPlaybackRate({ playbackRate: 1 / S })`.
//
// Both layers slow at the same factor, so JS-driven and CSS-driven
// motion stay in lockstep. Then we capture frames at S × the target frame
// interval in real time (e.g. 100 ms real time per frame for 60 fps with
// S = 6). Each captured frame is at the correct moment of the original
// animation; output encoded at the target fps plays back at the original
// speed.
//
// Trade-off: total recording wall time = (animation duration) × S. The
// default S = 10 keeps recordings tolerable for short animations and
// gives screenshots plenty of time even at 4K.
//
// Caveat: this approach doesn't slow Workers, WebSockets, or fetch (none
// of which are typical in claude-generated animations).

const SHIM_SOURCE = `(function(sf) {
  if (sf === 1) return;
  var rST = window.setTimeout.bind(window);
  var rSI = window.setInterval.bind(window);
  window.setTimeout = function(fn, ms) {
    var args = Array.prototype.slice.call(arguments, 2);
    return rST.apply(null, [fn, (ms || 0) * sf].concat(args));
  };
  window.setInterval = function(fn, ms) {
    var args = Array.prototype.slice.call(arguments, 2);
    return rSI.apply(null, [fn, (ms || 1) * sf].concat(args));
  };
  var rPerf = performance.now.bind(performance);
  var perfStart = rPerf();
  Object.defineProperty(performance, 'now', {
    value: function() { return (rPerf() - perfStart) / sf; },
    configurable: true, writable: true,
  });
  var rDate = Date.now.bind(Date);
  var dateStart = rDate();
  Date.now = function() { return dateStart + (rDate() - dateStart) / sf; };
  // NOTE: requestAnimationFrame is intentionally NOT wrapped. Per the
  // HTML5 spec, the timestamp passed to rAF callbacks "represents the
  // current time, the same value that performance.now() would return."
  // Chrome implements this by reading the live performance.now property
  // when constructing the timestamp argument — so our Object.defineProperty
  // override above already makes rAF callbacks receive slowed timestamps
  // for free. A wrapper here would slow the timestamp a SECOND time
  // (rAF receives slowed-by-sf, wrapper divides by sf again → sf² total).
  // That bug shipped silently for animations using rAF instead of
  // setTimeout/setInterval; canvas-driven animations were the most
  // common victims.
})`;

// =========================================================================
// Recording
// =========================================================================

// Open a page, inject the pre-load preamble, navigate, detect the driver,
// and apply per-driver setup. Returns { page, driver }; the caller owns
// page.close(). Shared by the single-browser recorder (recordJob) and the
// frame-sharded recorder (recordJobSharded).
async function preparePage(browser, job, opts) {
  const page = await browser.newPage();
  await page.setViewport({
    width: job.width,
    height: job.height,
    // job.renderScale is opts.scale normally, or the auto-picked integer
    // supersampling scale when --output-height is set.
    deviceScaleFactor: job.renderScale,
  });

  // Inject the pre-load preamble before any page script runs: the
  // __SCRUB__ flag plus the JS time-slowdown shim.
  //
  //   - `window.__SCRUB__ = true` tells a seek-aware page (one exposing
  //     `window.seek`) NOT to autoplay — it renders frame 0 and
  //     waits to be driven by seek(). For every other page it's an inert
  //     global. It MUST be set before load, but the driver decision can
  //     only be made after load (we have to probe the page to know if it
  //     exposes seek). So we set it unconditionally up front and
  //     pick the driver below — a no-op for play-driven pages.
  //   - The slowdown shim is only consumed by the play driver. It's
  //     harmless for seek pages, which use no timers for choreography.
  //
  // Two injection paths because Puppeteer treats the content-loading
  // modes differently:
  //
  //   - For single-file (`page.goto`), the navigation creates a new
  //     document and `evaluateOnNewDocument` fires the preamble before
  //     any page script runs. Standard pattern.
  //
  //   - For bundles (`page.setContent`), Puppeteer uses
  //     `document.open(); document.write(html); document.close()` on the
  //     existing about:blank — this is NOT a navigation, so
  //     `evaluateOnNewDocument` never fires. Without intervention, the
  //     bundle's scripts call the raw, un-shimmed `setTimeout` /
  //     `performance.now` / `Date.now` / `requestAnimationFrame` (and
  //     never see __SCRUB__). Fix: inject directly into the about:blank
  //     window via `page.evaluate` before `setContent`. `document.write()`
  //     replaces the document but not the window, so the preamble's
  //     wrappers and globals persist into the new content's scope.
  const scrub = 'window.__SCRUB__ = true;';
  if (job.mode === 'bundle') {
    await page.evaluate(`${scrub}(${SHIM_SOURCE})(${opts.slowdown});`);
    await page.setContent(job.bundleHtml, { waitUntil: 'load' });
  } else {
    await page.evaluateOnNewDocument(`${scrub}${SHIM_SOURCE}(${opts.slowdown});`);
    await page.goto('file://' + job.inputPath, { waitUntil: 'load' });
  }

  // Driver selection (auto-detect). A page that exposes `window.seek`
  // is seek-aware: its scene is a pure function of time, so we can scrub
  // it frame-by-frame — frame-perfect and with no slowdown wall-time
  // penalty. Everything else uses the play driver (slow the clocks by S,
  // pace screenshots to match). The probe runs post-load, which is why
  // __SCRUB__ was injected unconditionally above. The presence of the
  // function is both the capability signal and the behavioral hook; no
  // separate metadata global is required (duration/viewport come from the
  // meta tags h2v already parses pre-launch).
  const seekable = await page.evaluate(
    () => typeof window.seek === 'function'
  );
  const driver = seekable ? 'seek' : 'play';

  // Slow CSS animations / transitions / Web Animations API entries
  // proportionally — play driver only. Must be set after navigation so
  // the timeline exists. The seek driver drives state explicitly and
  // never advances a clock, so the CDP playback rate is irrelevant to it.
  if (driver === 'play') {
    const client = await page.target().createCDPSession();
    await client.send('Animation.enable');
    if (opts.slowdown !== 1) {
      await client.send('Animation.setPlaybackRate', {
        playbackRate: 1 / opts.slowdown,
      });
    }
  }

  if (job.theme) {
    await page.evaluate(
      (t) => document.documentElement.setAttribute('data-theme', t),
      job.theme
    );
  }

  await page.evaluate(() =>
    document.documentElement.setAttribute('data-h2v-recording', '')
  );
  await page.addStyleTag({
    content: '[data-h2v-hide]{display:none!important}',
  });

  if (driver === 'seek') {
    // Wait for web fonts before the first capture (the play path relies on
    // the slowdown to give fonts time; seek captures frame 0 almost
    // immediately, so we wait explicitly), then a short settle.
    await page.evaluate(async () => {
      if (document.fonts) await document.fonts.ready;
    });
    await new Promise((r) => setTimeout(r, 150));
  }

  return { page, driver };
}

function makeCaptureDir(capturesRoot, job) {
  const captureDir = path.join(capturesRoot, job.captureKey);
  fs.rmSync(captureDir, { recursive: true, force: true });
  fs.mkdirSync(captureDir, { recursive: true });
  return captureDir;
}

function screenshotOptsFor(opts) {
  // omitBackground tells Chromium to skip painting its default white
  // viewport background, exposing the page's own background-color (or
  // transparency, if the page sets none / declares it transparent).
  // Only meaningful with PNG capture — JPEG has no alpha channel.
  // resolveExportOpts already enforces the format=png pairing.
  return opts.captureFormat === 'png'
    ? { type: 'png', omitBackground: opts.alpha }
    : { type: 'jpeg', quality: opts.captureQuality };
}

// Seek capture for the frame subrange [frameStart, frameEnd). Each frame is
// `seek(ms)` then screenshot, no pacing sleep — wall time is just the
// screenshots. Frames span the job's [0, totalFrames): tᵢ = i × (1000/fps),
// so frame 0 is the true t=0. On-disk names are 1-based (`0001..N`) to match
// ffmpegStitch's `-start_number 1`, same as the play path. Because seek() is
// deterministic and order-independent, disjoint subranges can run on separate
// browsers concurrently and write into the same captureDir (see
// recordJobSharded).
async function captureSeekRange(
  page, job, opts, captureDir, captureExt, screenshotOpts, frameStart, frameEnd, quiet
) {
  // Warm-up: replay the seek sequence from frame 0 up to frameStart WITHOUT
  // screenshotting. The seek contract says seek(ms) is a pure function of
  // time, but real timeline engines (e.g. animation-kit's) often carry
  // incremental state, so jumping cold to frameStart renders differently
  // than arriving there frame-by-frame. Replaying the prefix reproduces the
  // exact state a single-pass recording reaches at frameStart, making shard
  // output byte-identical to single-worker. seek() is ~1 ms vs ~25–55 ms per
  // screenshot, so the prefix replay is cheap relative to capture. No-op for
  // frameStart === 0 (the single-worker path and shard 0).
  for (let i = 0; i < frameStart; i++) {
    await page.evaluate((ms) => window.seek(ms), (i * 1000) / opts.fps);
  }
  for (let i = frameStart; i < frameEnd; i++) {
    const t = (i * 1000) / opts.fps;
    await page.evaluate((ms) => window.seek(ms), t);
    const fileName = String(i + 1).padStart(4, '0') + '.' + captureExt;
    await page.screenshot({
      ...screenshotOpts,
      path: path.join(captureDir, fileName),
    });
    const done = i + 1;
    if (!quiet && (done % opts.fps === 0 || done === job.totalFrames)) {
      process.stdout.write(`\r    captured ${done}/${job.totalFrames}`);
    }
  }
}

// Play capture: pace screenshots at S × frame-interval real ms so the slowed
// page advances exactly one target frame-interval per shot. Always captures
// the full [0, totalFrames) — play is inherently sequential/real-time and
// cannot be sharded.
async function capturePlay(
  page, job, opts, captureDir, captureExt, screenshotOpts, quiet
) {
  const tickMsReal = (1000 / opts.fps) * opts.slowdown;
  const startReal = Date.now();
  for (let i = 1; i <= job.totalFrames; i++) {
    const target = startReal + i * tickMsReal;
    const wait = target - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const fileName = String(i).padStart(4, '0') + '.' + captureExt;
    await page.screenshot({
      ...screenshotOpts,
      path: path.join(captureDir, fileName),
    });
    if (!quiet && (i % opts.fps === 0 || i === job.totalFrames)) {
      process.stdout.write(`\r    captured ${i}/${job.totalFrames}`);
    }
  }
}

function driverLogLine(driver, opts) {
  return driver === 'seek'
    ? 'seek (frame-perfect, no slowdown)'
    : `slowdown ${opts.slowdown}×`;
}

// Single-browser recorder: prepare one page, capture the whole job on it.
// Used by the sequential path and the whole-job parallel pool.
async function recordJob(browser, job, opts, capturesRoot, logPrefix = '    ') {
  const captureDir = makeCaptureDir(capturesRoot, job);
  const captureExt = CAPTURE_EXT_FOR_FORMAT[opts.captureFormat];
  const screenshotOpts = screenshotOptsFor(opts);
  const { page, driver } = await preparePage(browser, job, opts);
  try {
    console.log(`${logPrefix}driver: ${driverLogLine(driver, opts)}`);
    if (driver === 'seek') {
      await captureSeekRange(page, job, opts, captureDir, captureExt, screenshotOpts, 0, job.totalFrames, opts.quietProgress);
    } else {
      await capturePlay(page, job, opts, captureDir, captureExt, screenshotOpts, opts.quietProgress);
    }
    if (!opts.quietProgress) process.stdout.write('\n');
    return captureDir;
  } finally {
    try { await page.close(); } catch { /* ignore cleanup errors */ }
  }
}

// Partition [0, total) into `parts` contiguous [start, end) ranges that
// exactly cover it (the first `total % parts` ranges get one extra frame).
// Yields fewer than `parts` ranges only when parts > total.
function splitFrameRanges(total, parts) {
  const ranges = [];
  const base = Math.floor(total / parts);
  let rem = total % parts;
  let start = 0;
  for (let k = 0; k < parts; k++) {
    const size = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
    if (size === 0) continue;
    ranges.push([start, start + size]);
    start += size;
  }
  return ranges;
}

// Frame-sharded recorder for a single job. A seek page's scene is a pure
// function of time and seek() is order-independent, so we split
// [0, totalFrames) across up to `maxWorkers` independent browser processes
// (Chrome serializes screenshots intra-process — see runJobsParallel — so it
// MUST be separate browsers, one page each, not multiple pages in one
// browser). Each shard writes its frames by global 1-based index into the
// shared captureDir; ffmpegStitch then sees one contiguous 0001..N sequence.
//
// Worker 0's page load doubles as the driver probe, so it isn't wasted: if
// the page turns out to be play (un-shardable, real-time sequential) or too
// small to be worth splitting, worker 0 simply captures the whole range on
// its already-open browser — identical to the single-browser path.
async function recordJobSharded(job, opts, capturesRoot, puppeteer, maxWorkers, logPrefix = '    ') {
  const captureDir = makeCaptureDir(capturesRoot, job);
  const captureExt = CAPTURE_EXT_FOR_FORMAT[opts.captureFormat];
  const screenshotOpts = screenshotOptsFor(opts);

  const browser0 = await launchBrowser(puppeteer);
  const { page: page0, driver } = await preparePage(browser0, job, opts);

  // Shard count: bounded by the worker budget AND by keeping each shard big
  // enough to amortize its ~page-load overhead (SEEK_SHARD_MIN_FRAMES). Play
  // jobs and small seek jobs collapse to K=1 (no fan-out).
  const K = driver === 'seek'
    ? Math.max(1, Math.min(maxWorkers, Math.floor(job.totalFrames / SEEK_SHARD_MIN_FRAMES)))
    : 1;

  if (K <= 1) {
    try {
      console.log(`${logPrefix}driver: ${driverLogLine(driver, opts)}`);
      if (driver === 'seek') {
        await captureSeekRange(page0, job, opts, captureDir, captureExt, screenshotOpts, 0, job.totalFrames, opts.quietProgress);
      } else {
        await capturePlay(page0, job, opts, captureDir, captureExt, screenshotOpts, opts.quietProgress);
      }
      if (!opts.quietProgress) process.stdout.write('\n');
    } finally {
      try { await page0.close(); } catch { /* ignore */ }
      try { await browser0.close(); } catch { /* ignore */ }
    }
    return captureDir;
  }

  // Seek + worth sharding: fan out. Worker 0 takes ranges[0] on the
  // already-open page0; helper browsers take the rest. Per-frame progress is
  // suppressed (K concurrent writers would clobber the \r line).
  const ranges = splitFrameRanges(job.totalFrames, K);
  console.log(
    `${logPrefix}driver: seek (frame-perfect, no slowdown) — ` +
    `${job.totalFrames} frames across ${ranges.length} browsers`
  );

  const worker0 = (async () => {
    try {
      await captureSeekRange(page0, job, opts, captureDir, captureExt, screenshotOpts, ranges[0][0], ranges[0][1], true);
    } finally {
      try { await page0.close(); } catch { /* ignore */ }
      try { await browser0.close(); } catch { /* ignore */ }
    }
  })();

  const helpers = ranges.slice(1).map(([start, end]) => (async () => {
    const browser = await launchBrowser(puppeteer);
    try {
      const { page } = await preparePage(browser, job, opts);
      try {
        await captureSeekRange(page, job, opts, captureDir, captureExt, screenshotOpts, start, end, true);
      } finally {
        try { await page.close(); } catch { /* ignore */ }
      }
    } finally {
      try { await browser.close(); } catch { /* ignore */ }
    }
  })());

  await Promise.all([worker0, ...helpers]);
  return captureDir;
}

// =========================================================================
// FFmpeg
// =========================================================================

function ensureFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (r.error || r.status !== 0) {
    console.error(
      'error: ffmpeg not found on PATH. Install it (e.g. `brew install ffmpeg`) ' +
      'or pass --no-ffmpeg to capture PNGs only.'
    );
    process.exit(1);
  }
}

// Per-codec encode args. The quality preset (opts.qualityPreset) influences
// codec-specific encoder choices: pix_fmt subsampling, x264/x265 -preset
// (effort level), -tune, and the ProRes profile. Higher tiers reach for
// 4:4:4 chroma and the slowest encoder presets; lower tiers prioritize
// encode speed. The preset's CRF/codec/capture choices were already
// applied to opts in resolveExportOpts.
function buildEncodeArgs(opts) {
  const tier = opts.qualityPreset;
  switch (opts.codec) {
    case 'libx264':
    case 'libx265': {
      // High and max tiers use full 4:4:4 chroma. Acceptable for our
      // content (HTML animations, often saturated colors, sharp edges)
      // at the cost of compatibility with some hardware h264 decoders
      // and Safari.
      const pixFmt = (tier === 'high' || tier === 'max') ? 'yuv444p' : 'yuv420p';
      const profileArgs = pixFmt === 'yuv444p' ? ['-profile:v', 'high444'] : [];
      const encoderPreset =
        tier === 'high' || tier === 'max' ? 'veryslow' :
        tier === 'draft' ? 'ultrafast' :
        'medium';
      // -tune animation is purpose-built for animated content (more
      // reference frames, deblocking adjustments, psy-rd weighting tuned
      // for sharp edges and flat regions). x264's "ultrafast" preset
      // disables most of what tune turns on, so we skip it for draft.
      const tuneArgs = tier === 'draft' ? [] : ['-tune', 'animation'];
      // -tag:v hvc1 makes h265 .mp4 playable in QuickTime/Safari; harmless
      // in .mov. Without it most Apple players reject the stream.
      const hvcTag = opts.codec === 'libx265' && (opts.container === 'mp4' || opts.container === 'mov')
        ? ['-tag:v', 'hvc1'] : [];
      // Silence libx265's verbose per-frame stats (it has its own logger
      // that ffmpeg's -loglevel doesn't reach).
      const x265Quiet = opts.codec === 'libx265'
        ? ['-x265-params', 'log-level=error'] : [];
      return [
        '-c:v', opts.codec,
        '-pix_fmt', pixFmt,
        '-crf', String(opts.crf),
        ...profileArgs,
        '-preset', encoderPreset,
        ...tuneArgs,
        ...hvcTag,
        ...x265Quiet,
      ];
    }
    case 'libvpx-vp9': {
      // VP9 quality knob is -deadline + -cpu-used. "best" with cpu-used 0
      // is the slowest, highest-quality mode; "realtime" with cpu-used 8
      // is the fastest. -b:v 0 puts libvpx in constant-quality (CRF) mode.
      const deadline = tier === 'draft' ? 'realtime' : 'best';
      const cpuUsed = tier === 'draft' ? '8' : '0';
      return [
        '-c:v', 'libvpx-vp9',
        '-pix_fmt', 'yuv420p',
        '-crf', String(opts.crf),
        '-b:v', '0',
        '-deadline', deadline,
        '-cpu-used', cpuUsed,
      ];
    }
    case 'png': {
      // PNG codec inside MOV: bit-exact lossless per-frame zlib + filter
      // compression. Pix_fmt rgba when alpha is on, rgb24 otherwise;
      // both are lossless. PNG codec has no quality knobs — --crf and
      // --quality-preset are ignored. Note: PNG-with-alpha decodes
      // unreliably in CapCut at 4K + long durations (verified
      // empirically). It's kept as an opt-in for non-CapCut workflows
      // (IINA, QuickTime, FCP); the --alpha default is qtrle.
      const pixFmt = opts.alpha ? 'rgba' : 'rgb24';
      return [
        '-c:v', 'png',
        '-pix_fmt', pixFmt,
      ];
    }
    case 'qtrle': {
      // QuickTime Animation (qtrle) inside MOV: RLE-lossless, native
      // Apple codec, very broad NLE compatibility. The default --alpha
      // codec because it's the only lossless alpha-capable codec we
      // tested that decodes correctly in CapCut at 4K + long durations.
      // pix_fmt argb is the qtrle-native alpha layout; rgb24 when alpha
      // is off keeps the codec sensible but the path is rarely useful
      // (qtrle's whole reason for existence in h2v is alpha support).
      // No quality knobs — --crf and --quality-preset are ignored.
      const pixFmt = opts.alpha ? 'argb' : 'rgb24';
      return [
        '-c:v', 'qtrle',
        '-pix_fmt', pixFmt,
      ];
    }
    case 'prores_ks': {
      // Profile 4 = ProRes 4444 (12-bit 4:4:4) for max tier. Profile 3 =
      // HQ (10-bit 4:2:2) for everything else — the editing-friendly
      // default. -vendor apl0 marks the file as Apple-vendor ProRes,
      // which some pickier NLEs require. ProRes ignores --crf entirely.
      //
      // Alpha override: --alpha forces profile 4 + yuva444p10le (4444 is
      // the only ProRes profile with an alpha plane) and -vendor apl0,
      // regardless of the active --quality-preset tier. resolveExportOpts
      // guarantees opts.codec === 'prores_ks' and container === 'mov'
      // when opts.alpha is set.
      if (opts.alpha) {
        return [
          '-c:v', 'prores_ks',
          '-profile:v', '4',
          '-pix_fmt', 'yuva444p10le',
          '-vendor', 'apl0',
        ];
      }
      const profile = tier === 'max' ? '4' : '3';
      const pixFmt = tier === 'max' ? 'yuv444p10le' : 'yuv422p10le';
      const vendor = tier === 'max' ? ['-vendor', 'apl0'] : [];
      return [
        '-c:v', 'prores_ks',
        '-profile:v', profile,
        '-pix_fmt', pixFmt,
        ...vendor,
      ];
    }
    default:
      throw new Error(`unhandled codec: ${opts.codec}`);
  }
}

// GIF is a single-ffmpeg-pass palette pipeline (palettegen → paletteuse via
// filter_complex — no temp palette file). Quality (palette + dithering) is
// derived from the --quality-preset tier, the same way buildEncodeArgs derives
// per-codec choices from the tier:
//   max      per-frame palette (stats_mode=single + new=1), 256 colours,
//            sierra2_4a dither — best colour, largest files (PNG capture via
//            the max preset feeds it a cleaner source).
//   high     global palette, 256 colours, sierra2_4a dither.
//   standard global palette, 256 colours, bayer dither (default).
//   draft    global palette, 128 colours, no dither — smallest/flattest.
// diff_mode=rectangle re-encodes only changed regions (big win for h2v's
// mostly-static UI animations). The leading scale (when downscaling — see
// computeRenderPlan) lives INSIDE the filtergraph because palettegen needs
// the final resolution.
function buildGifFilterComplex(opts, job) {
  const tier = opts.qualityPreset;
  const perFrame = tier === 'max';
  const maxColors = tier === 'draft' ? 128 : 256;
  const dither =
    tier === 'max' || tier === 'high' ? 'dither=sierra2_4a' :
    tier === 'standard' ? 'dither=bayer:bayer_scale=3' :
    'dither=none';
  const palettegen = `palettegen=max_colors=${maxColors}${perFrame ? ':stats_mode=single' : ''}`;
  const paletteuse = `paletteuse=${dither}:diff_mode=rectangle${perFrame ? ':new=1' : ''}`;

  const pre = [];
  if (job && job.outputHeight != null
      && job.height * job.renderScale !== job.outputHeight) {
    pre.push(`scale=-2:${job.outputHeight}:flags=lanczos`);
  }
  const preStr = pre.length ? pre.join(',') + ',' : '';
  return `${preStr}split[a][b];[a]${palettegen}[p];[b][p]${paletteuse}`;
}

function ffmpegStitch(captureDir, outPath, opts, job) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const captureExt = CAPTURE_EXT_FOR_FORMAT[opts.captureFormat];

    // GIF: separate single-pass palette pipeline. No -vf / buildEncodeArgs /
    // faststart; -loop 0 makes it loop forever (the GIF norm).
    if (opts.gif) {
      const args = [
        '-y',
        '-loglevel', 'error',
        '-framerate', String(opts.fps),
        '-start_number', '1',
        '-i', path.join(captureDir, '%04d.' + captureExt),
        '-filter_complex', buildGifFilterComplex(opts, job),
        '-loop', '0',
        outPath,
      ];
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
      proc.on('error', reject);
      proc.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))
      );
      return;
    }
    // -movflags +faststart reorders the moov atom to the start of the
    // file so playback can begin while the file is still downloading.
    // Critical for web embedding; harmless for local playback. Only
    // applies to mp4/mov; webm is a Matroska variant with its own seek
    // index.
    const faststart = (opts.container === 'mp4' || opts.container === 'mov')
      ? ['-movflags', '+faststart'] : [];

    // Build the -vf filter chain. Order matters: premultiply BEFORE
    // downscale so alpha is scaled in premultiplied space (avoids edge
    // halos); the chain is applied left-to-right pre-encode.
    const vf = [];
    // Pre-multiply alpha (RGB×α) when --alpha is on with the default
    // --alpha-mode. Most video tools (CapCut, Resolve, Premiere, AE) assume
    // premultiplied alpha for compositing intermediates; without this,
    // semi-transparent pixels blow out (white halos on glows, solid colours
    // where semi-transparent backgrounds should be). --alpha-mode straight
    // opts out.
    if (opts.alpha && opts.alphaMode === 'premultiplied') {
      vf.push('premultiply=inplace=1');
    }
    // Supersampling downscale. Frames are captured at an integer render
    // scale that meets-or-exceeds the target (see computeRenderPlan); here we
    // Lanczos-downscale to the per-job target height, width auto (-2 =
    // preserve aspect, force even). Skipped when the captured height already
    // equals the target (exact integer fit → no resample). job.outputHeight
    // is null in --scale density mode (no downscale ever).
    if (job && job.outputHeight != null
        && job.height * job.renderScale !== job.outputHeight) {
      vf.push(`scale=-2:${job.outputHeight}:flags=lanczos`);
    }
    const vfArgs = vf.length ? ['-vf', vf.join(',')] : [];

    const args = [
      '-y',
      '-loglevel', 'error',
      '-framerate', String(opts.fps),
      '-start_number', '1',
      '-i', path.join(captureDir, '%04d.' + captureExt),
      ...vfArgs,
      ...buildEncodeArgs(opts),
      ...faststart,
      outPath,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    proc.on('error', reject);
    proc.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited with code ${code}`))
    );
  });
}

// =========================================================================
// Review command
// =========================================================================
//
// Build a single HTML page that embeds every animation from the given
// paths. Two serialization modes:
//   inline=false (default, tmpfile path) — single-file animations are
//     loaded via <iframe src="file://…"> so a browser refresh re-fetches
//     from disk; bundle frames have no individual file and fall back to
//     srcdoc inlining.
//   inline=true (--out path) — every animation is inlined via
//     <iframe srcdoc>, producing a self-contained portable page.
// Default flow: write to a tmpfile, open in browser, wait for SIGINT,
// delete on exit.

function safeJsonForScript(value) {
  // JSON.stringify produces literal "</script>" inside any embedded
  // animation HTML, which would terminate the outer <script> tag.
  // Escape "</" → "<\/" — equivalent in a JS string, invisible to the
  // HTML tokenizer.
  return JSON.stringify(value, null, 2).replace(/<\/(?=[a-zA-Z!])/g, '<\\/');
}

function buildReviewHtml(animations, { inline }) {
  // In live mode (inline=false), drop animations[].html for entries that
  // have a filePath — those will be loaded via iframe.src. Bundle frames
  // (filePath: null) still need their html inlined as srcdoc.
  const serialized = animations.map((a) => {
    const base = {
      id: a.id,
      title: a.title,
      source: a.source,
      viewport: a.viewport,
    };
    if (!inline && a.filePath) {
      return { ...base, src: pathToFileURL(a.filePath).href };
    }
    return { ...base, html: a.html };
  });

  const count = animations.length;
  const countLabel = `${count} animation${count === 1 ? '' : 's'}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>h2v review — ${countLabel}</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f4f4f5; --card-bg: #ffffff; --border: #d8d8dc;
  --text: #18181b; --muted: #6a6a72;
  --btn-bg: #ececef; --btn-hover: #dedee2;
  /* Tallest a preview stage may grow to, so 9:16 / portrait animations
     stay within the window instead of running off the bottom. */
  --max-stage-h: 82vh;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b0b0c; --card-bg: #161618; --border: #2a2a2d;
    --text: #e6e6e8; --muted: #9a9aa1;
    --btn-bg: #1f1f23; --btn-hover: #2a2a30;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg); color: var(--text);
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  min-height: 100vh;
}
.page-header {
  position: sticky; top: 0; z-index: 50;
  background: var(--bg); border-bottom: 1px solid var(--border);
  padding: 14px 28px; display: flex; align-items: center;
  justify-content: space-between;
}
.page-header h1 { margin: 0; font-size: 16px; font-weight: 600; }
.page-header h1 small {
  color: var(--muted); font-weight: 400; margin-left: 8px; font-size: 13px;
}
button.ctl {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 8px 14px; background: var(--btn-bg); border: 1px solid var(--border);
  border-radius: 8px; color: var(--text); font-size: 13px; cursor: pointer;
  font-family: monospace;
}
button.ctl:hover { background: var(--btn-hover); }
/* Icons are inlined Lucide SVGs (https://lucide.dev, ISC licensed) —
   copied in, not a dependency, so the review page stays self-contained.
   They use stroke="currentColor", so they take the button's text color. */
button.ctl svg { width: 14px; height: 14px; display: block; }
main {
  max-width: 1100px; margin: 0 auto; padding: 24px 20px 80px;
  display: grid; gap: 24px;
}
.card {
  background: var(--card-bg); border: 1px solid var(--border);
  border-radius: 12px; overflow: hidden;
}
.card-head {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; border-bottom: 1px solid var(--border);
}
.card-head .name {
  font-size: 14px; font-weight: 600; flex: 1; font-family: monospace;
}
.card-head .source {
  font-family: monospace; font-size: 11px; color: var(--muted);
}
.card-actions { display: flex; gap: 6px; flex: none; }
.card-btn {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: monospace; font-size: 11px; padding: 5px 9px;
  background: var(--btn-bg); border: 1px solid var(--border);
  border-radius: 6px; color: var(--muted); cursor: pointer;
  white-space: nowrap;
}
.card-btn:hover { background: var(--btn-hover); color: var(--text); }
.card-btn svg { width: 13px; height: 13px; display: block; flex: none; }
/* Scale-to-fit preview.

   The naive approach — sizing the iframe's CSS box to the design aspect
   ratio — clips any non-responsive animation, because an iframe's CSS
   pixel size IS its internal viewport: a 1080px-wide canvas squeezed into
   a 400px iframe renders into a 400px viewport and overflows.

   So instead the iframe is rendered at its NATURAL design pixel size
   (--anim-w × --anim-h px) — the page sees exactly the viewport it was
   authored for, nothing is clipped — then visually shrunk to fit via
   transform: scale(). The stage centres that fixed-size iframe with flex
   and scales it about its centre; a ResizeObserver keeps --fit-scale =
   min(stageW/animW, stageH/animH) so it fits inside both axes. In normal
   flow the stage's aspect-ratio makes both ratios equal (exact fill); in
   fullscreen the screen aspect differs, so the min letterboxes cleanly.

   Stage width is clamped to: container (100%), natural width (never
   upscale past 1:1), and the width whose scaled height == --max-stage-h
   (keeps portrait clips inside the window). */
.frame-stage {
  position: relative;
  width: min(
    100%,
    calc(var(--anim-w) * 1px),
    calc(var(--max-stage-h) * var(--anim-w) / var(--anim-h))
  );
  aspect-ratio: var(--anim-w) / var(--anim-h);
  margin: 0 auto;
  overflow: hidden;
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
}
/* Fullscreen: the stage fills the display; the min() in --fit-scale
   letterboxes the animation on black, centred by the flex above. */
.frame-stage:fullscreen { width: 100vw; height: 100vh; aspect-ratio: auto; background: #000; }
.frame-stage:-webkit-full-screen { width: 100vw; height: 100vh; aspect-ratio: auto; background: #000; }
.frame-iframe {
  flex: none;
  width: calc(var(--anim-w) * 1px);
  height: calc(var(--anim-h) * 1px);
  transform-origin: center center;
  transform: scale(var(--fit-scale, 1));
  border: 0;
  background: var(--bg);
}
.card-head .dims {
  font-family: monospace; font-size: 11px; color: var(--muted);
  white-space: nowrap;
}
</style>
</head>
<body>
<header class="page-header">
  <h1>h2v review <small>${countLabel}</small></h1>
  <button class="ctl" id="resetAll"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg><span>Reset all</span></button>
</header>
<main id="cards"></main>
<script>
const ANIMATIONS = ${safeJsonForScript(serialized)};

function loadInto(iframe, a) {
  if (a.src) {
    iframe.src = a.src;
  } else {
    iframe.srcdoc = a.html;
  }
}

function reload(iframe, a) {
  if (a.src) {
    // Setting iframe.src to the same URL is a no-op in some browsers;
    // bouncing through about:blank forces a fresh fetch from disk.
    iframe.src = 'about:blank';
    requestAnimationFrame(() => { iframe.src = a.src; });
  } else {
    // Reassigning srcdoc always re-parses the inlined HTML.
    iframe.srcdoc = a.html;
  }
}

const main = document.getElementById('cards');

// Inlined Lucide icons (https://lucide.dev, ISC licensed) — copied in, not
// a dependency. stroke="currentColor" makes them inherit the button color.
const ICON_MAXIMIZE = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
const ICON_EXTERNAL = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/></svg>';

// Reduced aspect-ratio label, e.g. 1920×1080 → "16:9", 1080×1920 → "9:16".
function gcd(a, b) { return b ? gcd(b, a % b) : a; }
function aspectLabel(w, h) {
  const g = gcd(w, h) || 1;
  return (w / g) + ':' + (h / g);
}

// Set --fit-scale = min(stageW/animW, stageH/animH) so the natural-size
// iframe is shrunk to fit within both axes — exact fill in normal flow,
// letterbox in fullscreen (where the screen aspect differs).
function fitStage(stage) {
  const animW = parseFloat(stage.style.getPropertyValue('--anim-w'));
  const animH = parseFloat(stage.style.getPropertyValue('--anim-h'));
  if (animW > 0 && animH > 0) {
    const s = Math.min(stage.clientWidth / animW, stage.clientHeight / animH);
    stage.style.setProperty('--fit-scale', s);
  }
}
const fitObserver = new ResizeObserver((entries) => {
  for (const entry of entries) fitStage(entry.target);
});

// Request fullscreen on a stage (Safari needs the webkit-prefixed call).
function goFullscreen(stage) {
  const req = stage.requestFullscreen || stage.webkitRequestFullscreen;
  if (req) req.call(stage);
}

// Open a single animation at its native (1:1) resolution in a new tab.
//
// We can't just point the tab at the animation file: its body usually sets
// overflow:hidden, which propagates to the viewport and prevents scrolling
// to reach parts of the canvas that overflow the window. Instead we open a
// blank tab (about:blank inherits this file:// page's origin, so it can host
// a file:// iframe) and write a minimal wrapper whose document scrolls
// normally, embedding the animation in an iframe sized to its native pixels.
// The iframe's own overflow no longer matters — the wrapper provides scroll.
function openNative(a) {
  const tab = window.open('', '_blank');
  if (!tab) return; // popup blocked
  const w = a.viewport.w, h = a.viewport.h;
  const d = tab.document;
  d.open();
  d.write(
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>html,body{margin:0;background:#0b0b0c;}' +
    'body{min-height:100vh;}' +
    'iframe{display:block;border:0;background:#0b0b0c;margin:0 auto;' +
    'width:' + w + 'px;height:' + h + 'px;}' +
    '</style></head><body></body></html>'
  );
  d.close();
  d.title = a.id + ' — ' + w + '×' + h;
  const frame = d.createElement('iframe');
  frame.width = w;
  frame.height = h;
  if (a.src) { frame.src = a.src; } else { frame.srcdoc = a.html; }
  d.body.appendChild(frame);
}

// Refit the fullscreen stage on enter/exit (RO usually catches it, but
// webkit fullscreen transitions can need an explicit nudge).
['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) => {
  document.addEventListener(ev, () => {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl && fsEl.classList && fsEl.classList.contains('frame-stage')) {
      fitStage(fsEl);
    }
  });
});

ANIMATIONS.forEach((a) => {
  const card = document.createElement('article');
  card.className = 'card';
  const head = document.createElement('div');
  head.className = 'card-head';
  const label = a.title || a.id;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = label;
  // Show the source only when it adds something beyond the name. For a
  // single file id === source === name, so it would just be a duplicate;
  // bundle frames carry "bundle/id", which is worth showing.
  let source = null;
  if (a.source && a.source !== label) {
    source = document.createElement('span');
    source.className = 'source';
    source.textContent = a.source;
  }
  const dims = document.createElement('span');
  dims.className = 'dims';
  dims.textContent =
    aspectLabel(a.viewport.w, a.viewport.h) + '  ·  ' + a.viewport.w + '×' + a.viewport.h;
  const stage = document.createElement('div');
  stage.className = 'frame-stage';
  stage.style.setProperty('--anim-w', a.viewport.w);
  stage.style.setProperty('--anim-h', a.viewport.h);
  const iframe = document.createElement('iframe');
  iframe.className = 'frame-iframe';
  iframe.title = a.title || a.id;
  iframe.setAttribute('loading', 'lazy');
  iframe.style.setProperty('--anim-w', a.viewport.w);
  iframe.style.setProperty('--anim-h', a.viewport.h);
  loadInto(iframe, a);
  stage.appendChild(iframe);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const fsBtn = document.createElement('button');
  fsBtn.className = 'card-btn';
  fsBtn.innerHTML = ICON_MAXIMIZE + '<span>Full screen</span>';
  fsBtn.title = 'View this animation full screen (Esc to exit)';
  fsBtn.addEventListener('click', () => goFullscreen(stage));
  const nativeBtn = document.createElement('button');
  nativeBtn.className = 'card-btn';
  // external-link icon signals it opens in a new tab.
  nativeBtn.innerHTML = '<span>Actual size</span>' + ICON_EXTERNAL;
  nativeBtn.title = 'Open at actual size (' + a.viewport.w + '×' + a.viewport.h + ', 100%) in a new tab';
  nativeBtn.addEventListener('click', () => openNative(a));
  actions.append(fsBtn, nativeBtn);

  head.append(name);
  if (source) head.append(source);
  head.append(dims, actions);
  card.append(head, stage);
  main.appendChild(card);
  fitObserver.observe(stage);
});

document.getElementById('resetAll').addEventListener('click', () => {
  document.querySelectorAll('.card').forEach((card, i) => {
    reload(card.querySelector('iframe'), ANIMATIONS[i]);
  });
});
</script>
</body>
</html>
`;
}

function openInBrowser(filePath) {
  const cmd =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'cmd' :
    'xdg-open';
  const args =
    process.platform === 'win32' ? ['/c', 'start', '""', filePath] :
    [filePath];
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    } catch (err) {
      reject(err);
      return;
    }
    proc.on('error', reject);
    // Don't wait for the spawned process; let it run independently.
    proc.unref();
    resolve();
  });
}

// =========================================================================
// --paste: read HTML content from the terminal (or piped stdin) instead
// of from a file path.
// =========================================================================
//
// On a TTY, we enable bracketed paste mode (the ANSI sequence `\x1b[?2004h`
// supported by every modern terminal — Terminal.app, iTerm2, gnome-terminal,
// Windows Terminal, VSCode terminal, etc.) so the terminal wraps any paste
// in `\x1b[200~ ... \x1b[201~` markers. We buffer everything between those
// markers as the payload, show a `[pasted N lines, N bytes]` summary the
// moment the closing marker arrives, then wait for a real Enter (a CR/LF
// outside the markers) to commit. Ctrl+C cancels; Ctrl+D commits as a
// fallback for any terminal where bracketed paste somehow doesn't work.
//
// On non-TTY stdin (e.g. `pbpaste | h2v export --paste`), we skip the
// interactive prompt entirely and just read stdin to EOF. Same code path
// downstream — the reader returns the buffered HTML either way.

function readPastedHtml() {
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => (buf += chunk));
      process.stdin.on('end', () => {
        if (buf.trim().length === 0) {
          console.error('error: --paste received no content on stdin');
          process.exit(1);
        }
        resolve(buf);
      });
      process.stdin.on('error', reject);
    });
  }

  return new Promise((resolve) => {
    process.stdout.write('\x1b[?2004h'); // enable bracketed paste
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();

    console.error('Paste HTML, then press Enter to start (Ctrl-C to cancel).');

    let buffer = '';
    let inPaste = false;
    let pasted = '';

    const cleanup = () => {
      process.stdout.write('\x1b[?2004l'); // disable bracketed paste
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
    };

    const commit = () => {
      cleanup();
      if (buffer.trim().length === 0) {
        console.error('error: no content received');
        process.exit(1);
      }
      resolve(buffer);
    };

    const cancel = (code = 130) => {
      cleanup();
      process.stderr.write('\nCancelled.\n');
      process.exit(code);
    };

    const onData = (chunk) => {
      let i = 0;
      while (i < chunk.length) {
        if (chunk.startsWith('\x1b[200~', i)) {
          inPaste = true;
          pasted = '';
          i += 6;
          continue;
        }
        if (chunk.startsWith('\x1b[201~', i)) {
          inPaste = false;
          buffer += pasted;
          const lines = pasted.split('\n').length;
          process.stderr.write(`[pasted ${lines} lines, ${pasted.length} bytes]\n`);
          pasted = '';
          i += 6;
          continue;
        }
        const ch = chunk[i];
        const code = chunk.charCodeAt(i);
        if (inPaste) {
          pasted += ch;
          i += 1;
          continue;
        }
        // Outside paste — handle keystrokes.
        if (code === 3) return cancel();              // Ctrl+C
        if (code === 4) return commit();              // Ctrl+D (fallback)
        if (ch === '\r' || ch === '\n') return commit();
        // Other keystrokes are ignored. We don't echo because raw mode
        // disables auto-echo; the only meaningful interaction here is
        // paste + Enter / cancel.
        i += 1;
      }
    };

    process.stdin.on('data', onData);
  });
}

// Write paste content to a unique temp directory under a fixed basename
// so the existing pipeline derives output paths from `paste` (not a
// timestamped temp filename). Caller is responsible for cleaning up the
// returned tempDir in a finally block.
function writePasteToTempFile(html) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2v-paste-'));
  const tempPath = path.join(tempDir, 'paste.html');
  fs.writeFileSync(tempPath, html);
  return { tempDir, tempPath };
}

function buildReviewAnimations(inputs) {
  const animations = [];
  for (const inputPath of inputs) {
    const text = fs.readFileSync(inputPath, 'utf8');
    const inputBase = path.basename(inputPath, path.extname(inputPath));
    if (detectMode(text) === 'bundle') {
      let frames;
      try {
        frames = parseBundleFrames(text, inputPath);
      } catch (err) {
        console.warn(`warning: skipping ${relativeToHere(inputPath)}: ${err.message}`);
        continue;
      }
      for (const frame of frames) {
        animations.push({
          id: frame.id,
          title: frame.title,
          source: `${inputBase}/${frame.id}`,
          html: frame.html,
          viewport: frame.viewport || DEFAULT_VIEWPORT,
          // Bundle frames are slices of a parent file with no individual
          // path on disk. In live mode they fall back to srcdoc inlining.
          filePath: null,
        });
      }
    } else {
      animations.push({
        id: inputBase,
        title: null,
        source: inputBase,
        html: text,
        viewport: extractViewport(text) || DEFAULT_VIEWPORT,
        // Absolute path so the review HTML (typically in os.tmpdir())
        // can address the source file via a file:// URL.
        filePath: path.resolve(inputPath),
      });
    }
  }
  return animations;
}

async function runReview(paths, opts) {
  // --paste: same flow as export. Materialize to a temp dir; clean up
  // on process exit. The synthetic basename `paste` falls out of the
  // existing input-discovery and output-naming logic.
  let pasteTempDir = null;
  if (opts.paste) {
    if (paths.length > 0) {
      console.error('error: --paste cannot be combined with positional path arguments');
      process.exit(2);
    }
    const html = await readPastedHtml();
    const written = writePasteToTempFile(html);
    pasteTempDir = written.tempDir;
    paths.push(written.tempPath);
    process.on('exit', () => {
      try { fs.rmSync(pasteTempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
  }

  const cwd = process.cwd();
  const inputs = discoverInputs(paths, cwd);

  if (inputs.length === 0) {
    console.error('error: no .html files matched. Pass paths or run from a directory containing animations.');
    process.exit(1);
  }

  const animations = buildReviewAnimations(inputs);
  if (animations.length === 0) {
    console.error('error: no animations to review.');
    process.exit(1);
  }

  const isTempFile = !opts.outOverride;
  // --out → inline all animations as srcdoc so the saved page is
  // portable. Default tmpfile → live mode: single-file iframes point at
  // file:// URLs so a browser refresh picks up edits to source files.
  const html = buildReviewHtml(animations, { inline: !isTempFile });
  const outPath = isTempFile
    ? path.join(os.tmpdir(), `h2v-review-${Date.now()}.html`)
    : path.resolve(cwd, opts.outOverride);

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html);
  } catch (err) {
    console.error(`error: could not write review file: ${err.message}`);
    process.exit(1);
  }

  console.log(
    `Review page (${animations.length} animation${animations.length === 1 ? '' : 's'}): ${outPath}`
  );

  if (!opts.skipOpen) {
    try {
      await openInBrowser(outPath);
    } catch (err) {
      console.warn(`warning: could not auto-open browser: ${err.message}`);
      console.warn(`open this file manually: ${outPath}`);
    }
  }

  // Decide whether to wait + clean up. We only auto-clean tmpfiles, and
  // only when the browser was actually opened (otherwise the user
  // probably wants the path to do something with).
  const willCleanup = isTempFile && !opts.keep && !opts.skipOpen;

  if (willCleanup) {
    console.log('Press Ctrl-C to close (and delete the temp file).');

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        fs.unlinkSync(outPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.warn(`\nwarning: could not delete ${outPath}: ${err.message}`);
          console.warn('you may need to delete it manually.');
        }
      }
    };

    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    process.on('exit', cleanup);

    // Keep the event loop alive until a signal arrives. `await new Promise`
    // alone is NOT enough on macOS — Node exits when there are no active
    // libuv handles (timers, sockets, etc.), and a pending Promise isn't
    // a handle. setInterval registers a real timer handle that keeps the
    // loop running until the signal handler calls process.exit().
    setInterval(() => {}, 1 << 30);
    await new Promise(() => {});
  }
}

// =========================================================================
// Bundle command
// =========================================================================
//
// `h2v bundle` is the inverse of the bundle path through `h2v export`. It
// reads a list of standalone HTML animations (and/or existing bundles),
// extracts each animation's metadata, and writes one bundle HTML file with
// ANIMATION_START / ANIMATION_END markers that `parseBundleFrames` already
// knows how to read on the export side. Round-trip property: bundling
// `demo/animations/` should produce a bundle semantically equivalent to
// the committed `demo/bundle.html` — same {id, capture_duration, viewport,
// themes, content} set per block. The bundle test (`tests/test-bundle.js`)
// enforces this.

function collectBundleAnimations(inputs) {
  const animations = [];
  for (const input of inputs) {
    const raw = fs.readFileSync(input, 'utf-8');
    if (detectMode(raw) === 'bundle') {
      // Existing bundle: decompose so each inner animation becomes its own
      // entry in the output bundle. parseBundleFrames already validates
      // marker shape, so any malformed input errors out here with a clear
      // file:line-ish message rather than producing a broken output bundle.
      const frames = parseBundleFrames(raw, input);
      for (const frame of frames) {
        animations.push({
          id: frame.id,
          captureDuration: frame.durationSeconds,
          viewport: frame.viewport,
          themes: frame.declaredThemes,
          content: frame.html,
          // sourcePath includes "#<id>" for bundle entries so duplicate-id
          // error messages name the specific animation within the bundle.
          sourcePath: `${input}#${frame.id}`,
        });
      }
    } else {
      // Standalone file: id from filename basename, metadata from <meta>
      // tags. Missing duration meta is non-fatal — we fall back to the
      // run-wide default and log a note so the user sees the fallback.
      const id = path.basename(input, '.html');
      let durationS = extractMetaDuration(raw);
      if (durationS == null) {
        console.error(
          `note: ${input}: no h2v-duration meta, using default ${DEFAULTS.duration}s`
        );
        durationS = DEFAULTS.duration;
      }
      animations.push({
        id,
        captureDuration: durationS,
        viewport: extractViewport(raw),  // null if absent → omitted from marker
        themes: extractDeclaredThemes(raw),  // [] if absent → omitted from marker
        content: raw,
        sourcePath: input,
      });
    }
  }
  return animations;
}

function renderBundle(animations) {
  // ISO date in the header lets future readers tell when an existing
  // bundle was generated without needing git history. No time-of-day —
  // we want this stable across re-bundles on the same day for diff-ability.
  const today = new Date().toISOString().slice(0, 10);
  const parts = [
    `<!-- Generated by h2v bundle on ${today}. See docs/authoring.md. -->`,
    '',
  ];
  for (const anim of animations) {
    const attrs = [
      `id="${anim.id}"`,
      `capture_duration="${anim.captureDuration}s"`,
    ];
    // viewport and themes are optional in the marker — only emit them
    // when present in the source so a bundle of plain files stays clean
    // (no `viewport=""` or `themes=""` clutter).
    if (anim.viewport) {
      attrs.push(`viewport="${anim.viewport.w}x${anim.viewport.h}"`);
    }
    if (anim.themes && anim.themes.length > 0) {
      attrs.push(`themes="${anim.themes.join(',')}"`);
    }
    parts.push(`<!-- ===== ANIMATION_START ${attrs.join(' ')} ===== -->`);
    parts.push(anim.content);
    parts.push(`<!-- ===== ANIMATION_END id="${anim.id}" ===== -->`);
    parts.push('');
  }
  return parts.join('\n');
}

function defaultBundleOutPath(paths, cwd) {
  // Single-dir input → derive bundle name from the directory:
  //   h2v bundle anims/    → output/anims.html
  // Anything else (mixed args, multiple dirs, no args) → output/bundle.html.
  if (paths.length === 1) {
    const abs = path.resolve(cwd, paths[0]);
    let stat;
    try { stat = fs.statSync(abs); } catch { stat = null; }
    if (stat && stat.isDirectory()) {
      const dirName = path.basename(abs);
      return path.resolve(cwd, DEFAULTS.outDir, `${dirName}.html`);
    }
  }
  return path.resolve(cwd, DEFAULTS.outDir, 'bundle.html');
}

async function runBundle(paths, opts) {
  const cwd = process.cwd();
  const inputs = discoverInputs(paths, cwd);

  if (inputs.length === 0) {
    console.error('error: no .html files matched. Pass paths or run from a directory containing animations.');
    process.exit(2);
  }

  let animations;
  try {
    animations = collectBundleAnimations(inputs);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }

  if (animations.length === 0) {
    console.error('error: no animations to bundle.');
    process.exit(2);
  }

  // Validate uniqueness of ids. Collisions are most likely from two
  // standalone files sharing a basename across different directories, or
  // from a standalone file colliding with an inner id from a decomposed
  // bundle. The error names both source paths so the user can decide
  // which to rename.
  const seenIds = new Map();
  for (const anim of animations) {
    if (seenIds.has(anim.id)) {
      console.error(
        `error: duplicate animation id "${anim.id}":\n` +
        `  ${seenIds.get(anim.id)}\n` +
        `  ${anim.sourcePath}`
      );
      process.exit(2);
    }
    seenIds.set(anim.id, anim.sourcePath);
  }

  const outPath = opts.outOverride
    ? path.resolve(cwd, opts.outOverride)
    : defaultBundleOutPath(paths, cwd);

  // Refuse to clobber a directory at the output path. (Overwriting an
  // existing file is fine — h2v export does the same.)
  if (fs.existsSync(outPath)) {
    const stat = fs.statSync(outPath);
    if (stat.isDirectory()) {
      console.error(`error: --out points to a directory: ${outPath}`);
      process.exit(2);
    }
  }

  const bundleHtml = renderBundle(animations);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, bundleHtml);

  console.log(
    `Wrote bundle: ${relativeToHere(outPath)} (${animations.length} animation${animations.length === 1 ? '' : 's'})`
  );
}

// =========================================================================
// Memory budget heuristic
// =========================================================================
//
// Rough rule of thumb: a headless Chrome's RSS at our settings is dominated
// by browser baseline (~150 MB) plus the capture surface, which scales
// roughly with megapixels (~30 MB/MP). At 4K (3840×2160 ≈ 8.3 MP) this
// gives ~400 MB, matching what we observed in tests/bench-parallel.js.
// The constants are deliberately approximate — false positives are
// preferable to silent OOMs, and the warning is non-blocking either way.

// Per-worker memory ceiling for a plan: each worker only renders one job
// at a time, so the worst-case is the largest single job's megapixel
// footprint, not the sum.
function estimateWorkerMemoryMb(jobs, opts) {
  let maxMp = 0;
  for (const j of jobs) {
    // Memory is driven by the captured (render) resolution, which is
    // j.renderScale — equal to opts.scale normally, or the supersampling
    // scale when --output-height is set.
    const mp = (j.width * j.renderScale) * (j.height * j.renderScale) / 1e6;
    if (mp > maxMp) maxMp = mp;
  }
  return Math.round(150 + 30 * maxMp);
}

// Available memory the OS could actually hand out without paging — i.e.
// free + reclaimable cache. This is much larger than os.freemem() on
// macOS and Linux, where the kernel aggressively uses RAM as cache.
//
// Probing path:
//   1. Node 22+: os.availableMemory() — accurate, cross-platform.
//   2. macOS:    parse `vm_stat` output (free + inactive + speculative
//                + purgeable pages). Compressor pages are excluded;
//                they're reclaimable too but more nuanced, so this is
//                slightly conservative.
//   3. Linux:    read /proc/meminfo's MemAvailable, the kernel's own
//                "really available" estimate.
//   4. Windows / unknown: fall back to os.freemem(), which on Windows
//                already represents available physical memory.
function getAvailableMemoryMb() {
  if (typeof os.availableMemory === 'function') {
    return Math.round(os.availableMemory() / 1024 / 1024);
  }
  if (process.platform === 'darwin') {
    const mb = getAvailableMemoryMacOS();
    if (mb !== null) return mb;
  }
  if (process.platform === 'linux') {
    const mb = getAvailableMemoryLinux();
    if (mb !== null) return mb;
  }
  return Math.round(os.freemem() / 1024 / 1024);
}

function getAvailableMemoryMacOS() {
  try {
    const out = spawnSync('vm_stat', [], { encoding: 'utf8' });
    if (out.status !== 0 || !out.stdout) return null;
    const text = out.stdout;
    const pageSizeMatch = text.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096;
    const pagesOf = (label) => {
      const m = text.match(new RegExp('Pages ' + label + ':\\s+(\\d+)\\.'));
      return m ? parseInt(m[1], 10) : 0;
    };
    const reclaimable = pagesOf('free') + pagesOf('inactive') +
      pagesOf('speculative') + pagesOf('purgeable');
    if (reclaimable === 0) return null;
    return Math.round(reclaimable * pageSize / 1024 / 1024);
  } catch {
    return null;
  }
}

function getAvailableMemoryLinux() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = text.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (m) return Math.round(parseInt(m[1], 10) / 1024);
  } catch { /* ignore */ }
  return null;
}

function checkMemoryBudget(jobs, opts, concurrency) {
  const perWorker = estimateWorkerMemoryMb(jobs, opts);
  const total = perWorker * concurrency;
  const available = getAvailableMemoryMb();
  const budget = Math.round(available * 0.7);
  if (total <= budget) return;
  const safeK = Math.max(1, Math.floor(budget / perWorker));
  const workerWord = concurrency === 1 ? 'worker' : 'workers';
  const lines = [
    `warning: this run may exceed available memory.`,
    `         estimated ${total} MB needed (${perWorker} MB × ${concurrency} ${workerWord}), ~${available} MB available.`,
    `         this is a rough heuristic — safe to ignore on machines with headroom.`,
  ];
  if (concurrency > 1 && safeK < concurrency) {
    lines.push(`         to be safer, try --concurrency ${safeK}.`);
  }
  console.warn('\n' + lines.join('\n'));
}

// =========================================================================
// Job execution: sequential and parallel paths
// =========================================================================

function launchBrowser(puppeteer) {
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
}

async function runJobsSequential(jobs, opts, capturesRoot, puppeteer) {
  const browser = await launchBrowser(puppeteer);
  try {
    for (const job of jobs) {
      const startedAt = Date.now();
      console.log(`\n${job.label} ${job.durationSeconds}s × ${opts.fps}fps = ${job.totalFrames} frames`);
      const captureDir = await recordJob(browser, job, opts, capturesRoot);
      if (!opts.skipFfmpeg) {
        const outPath = outputPathFor(job, opts);
        console.log(`    encoding → ${relativeToHere(outPath)}`);
        await ffmpegStitch(captureDir, outPath, opts, job);
      }
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`    done in ${elapsed}s`);
    }
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
}

// Worker-pool: K independent browsers each pull from a shared job queue.
// Independent browser processes parallelize cleanly (verified in
// tests/bench-parallel.js); pages inside one browser do not — Chrome's
// screenshot pipeline serializes intra-process, so K=2 with mode A made
// each capture 16× slower in the bench. Hence one-browser-per-worker.
async function runJobsParallel(jobs, opts, capturesRoot, puppeteer, K) {
  const queue = jobs.slice();
  let completed = 0;
  const total = jobs.length;
  // Suppress per-frame `\r` progress; with K writers it would clobber.
  const workerOpts = { ...opts, quietProgress: true };

  const worker = async (idx) => {
    const browser = await launchBrowser(puppeteer);
    try {
      while (true) {
        const job = queue.shift();
        if (!job) break;
        const startedAt = Date.now();
        console.log(`[w${idx}] start  ${job.label} ${job.durationSeconds}s × ${opts.fps}fps = ${job.totalFrames} frames`);
        const captureDir = await recordJob(browser, job, workerOpts, capturesRoot, `[w${idx}] `);
        if (!opts.skipFfmpeg) {
          const outPath = outputPathFor(job, opts);
          await ffmpegStitch(captureDir, outPath, opts, job);
        }
        completed++;
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`[w${idx}] done   ${job.label} in ${elapsed}s  [${completed}/${total}]`);
      }
    } finally {
      try { await browser.close(); } catch { /* ignore */ }
    }
  };

  await Promise.all(Array.from({ length: K }, (_, i) => worker(i)));
}

// Frame-sharding path: used when there are fewer jobs than the requested
// worker budget, so spare workers can be spent splitting a large seek job's
// frames across browsers instead of sitting idle. Jobs run one at a time;
// each gets the full budget K for its own frames (the common case is a
// single long animation). Play jobs and small seek jobs degrade gracefully
// to a single browser inside recordJobSharded.
async function runJobsFrameSharded(jobs, opts, capturesRoot, puppeteer, K) {
  for (const job of jobs) {
    const startedAt = Date.now();
    console.log(`\n${job.label} ${job.durationSeconds}s × ${opts.fps}fps = ${job.totalFrames} frames`);
    const captureDir = await recordJobSharded(job, opts, capturesRoot, puppeteer, K);
    if (!opts.skipFfmpeg) {
      const outPath = outputPathFor(job, opts);
      console.log(`    encoding → ${relativeToHere(outPath)}`);
      await ffmpegStitch(captureDir, outPath, opts, job);
    }
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`    done in ${elapsed}s`);
  }
}

// =========================================================================
// Main
// =========================================================================

async function main() {
  const { paths, opts } = parseArgs(process.argv);

  if (opts.command === 'review') {
    return runReview(paths, opts);
  }
  if (opts.command === 'bundle') {
    return runBundle(paths, opts);
  }

  resolveExportOpts(opts);

  // --paste: read HTML interactively (or from non-TTY stdin) instead of
  // from a file. We materialize the paste to a temp file with the fixed
  // basename `paste` so the existing pipeline derives output paths
  // automatically (output/paste/<id>.<ext> for bundles,
  // output/paste.<ext> for single-file). Cleanup runs in the finally
  // below regardless of how export exits.
  let pasteTempDir = null;
  if (opts.paste) {
    if (paths.length > 0) {
      console.error('error: --paste cannot be combined with positional path arguments');
      process.exit(2);
    }
    const html = await readPastedHtml();
    const written = writePasteToTempFile(html);
    pasteTempDir = written.tempDir;
    paths.push(written.tempPath);
    // Clean up on ANY exit, not just the normal path. main() has several
    // early exits before the try/finally below (--dry-run, validatePlan /
    // buildPlan / no-match process.exit()), so a finally alone would leak
    // the temp dir on those. Mirror runReview's process.on('exit') guard.
    process.on('exit', () => {
      try { fs.rmSync(pasteTempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
  }

  const cwd = process.cwd();
  const inputs = discoverInputs(paths, cwd);

  if (inputs.length === 0) {
    console.error('error: no .html files matched. Pass paths or run from a directory containing animations.');
    process.exit(1);
  }

  let jobs;
  try {
    jobs = buildPlan(inputs, opts);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
  validatePlan(jobs, opts);

  printPlan(jobs, opts);

  // Execution mode — `--concurrency N` is one browser budget, spent one of
  // three ways depending on how many jobs there are:
  //   - sequential : no parallelism requested (--concurrency 1).
  //   - frameshard : exactly ONE job, so there's no job-level parallelism to
  //                  spend the budget on — instead split that job's frames
  //                  across browsers (seek only; play/small jobs degrade to a
  //                  single browser inside recordJobSharded). This is the new
  //                  behavior; everything else is unchanged.
  //   - jobpool    : 2+ jobs — run whole jobs in parallel, exactly as before.
  // Gating frame-sharding to a single job is deliberate: with 2+ jobs,
  // job-level parallelism already uses the budget, and sharding sequentially
  // would REGRESS multi-job batches (especially un-shardable play jobs, which
  // would run one-after-another instead of in parallel). A fair-share hybrid
  // (shard within while also running jobs concurrently) is possible later.
  const requested = opts.concurrency;
  const mode = requested <= 1 ? 'sequential'
    : jobs.length === 1 ? 'frameshard'
    : 'jobpool';

  // Peak concurrent browsers, for the memory estimate. Frame-sharding may
  // spin up the full requested budget on its one job.
  const peakBrowsers = mode === 'sequential' ? 1
    : mode === 'jobpool' ? Math.min(requested, jobs.length)
    : requested;

  // Memory-budget warning fires in dry-run too — users may want to preview
  // whether a planned --concurrency setting will fit before committing.
  checkMemoryBudget(jobs, opts, peakBrowsers);

  if (opts.dryRun) return;

  if (!opts.skipFfmpeg) ensureFfmpeg();

  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (err) {
    console.error('error: puppeteer is not installed. Run `npm install` first.');
    process.exit(1);
  }

  const capturesRoot = path.resolve(cwd, 'captures');
  fs.mkdirSync(capturesRoot, { recursive: true });
  fs.mkdirSync(path.resolve(cwd, opts.outDir), { recursive: true });

  const captureDesc = opts.captureFormat === 'png'
    ? 'png'
    : `jpeg q=${opts.captureQuality}`;
  const tier = opts.qualityPreset;
  // --alpha forces ProRes profile 4 (4444) regardless of tier; show that
  // in the summary so the log doesn't claim profile 3 when alpha is on.
  let codecDesc;
  // The alpha-mode suffix is part of the codec description because it
  // changes the bytes that go into the file (a -vf premultiply step in
  // ffmpegStitch). Worth surfacing in the run summary so the user can
  // see at a glance which interpretation was baked in.
  const alphaSuffix = opts.alpha
    ? ` + alpha (${opts.alphaMode === 'premultiplied' ? 'pre-mult' : 'straight'})`
    : '';
  if (opts.codec === 'gif') {
    codecDesc = `gif (${tier} palette)`;
  } else if (opts.codec === 'prores_ks') {
    const proresProfile = (opts.alpha || tier === 'max') ? '4 (4444)' : '3 (HQ)';
    codecDesc = `${opts.codec} profile ${proresProfile}${alphaSuffix}`;
  } else if (opts.codec === 'png' || opts.codec === 'qtrle') {
    codecDesc = `${opts.codec} (lossless${alphaSuffix})`;
  } else {
    codecDesc = `${opts.codec} crf ${opts.crf}`;
  }
  // Resolution summary. Three shapes: density (--scale, no downscale),
  // target (default 4K-fit or --output-height — render at an integer scale
  // then Lanczos-downscale to the target). Per-job rows carry precise sizes
  // when viewports vary; this line summarizes.
  const sizes = new Set(jobs.map((j) => `${j.width * j.renderScale}x${j.height * j.renderScale}`));
  const single = sizes.size === 1;
  const j0 = jobs[0];
  let sizeDesc;
  if (opts.scaleExplicit) {
    // Density mode: output = viewport × scale, no resample.
    sizeDesc = single
      ? `${j0.width * opts.scale}×${j0.height * opts.scale} (${j0.width}×${j0.height} × ${opts.scale})`
      : `varied resolutions (× ${opts.scale} scale)`;
  } else {
    // Target mode (default 4K-fit, or --output-height). Show render → target.
    const targetLabel = opts.outputHeight != null ? `${opts.outputHeight}p` : '4K-fit';
    if (!single) {
      sizeDesc = `varied render sizes → ${targetLabel}`;
    } else {
      const renderDesc = `${j0.width * j0.renderScale}×${j0.height * j0.renderScale} (${j0.width}×${j0.height} × ${j0.renderScale})`;
      const exact = j0.height * j0.renderScale === j0.outputHeight;
      if (exact) {
        sizeDesc = renderDesc;
      } else {
        const outW = 2 * Math.round((j0.width / j0.height) * j0.outputHeight / 2);
        sizeDesc = `${renderDesc} → downscaled to ${outW}×${j0.outputHeight}`;
      }
    }
  }
  console.log(
    `\nRecording at ${sizeDesc}, ${opts.fps}fps, ` +
    `preset ${tier}: capture ${captureDesc}, ${codecDesc} → .${opts.container}, ` +
    `slowdown ${opts.slowdown}× (wall time = animation × ${opts.slowdown})` +
    (peakBrowsers > 1
      ? `, concurrency ${peakBrowsers}${mode === 'frameshard' ? ' (frame-sharded for seek jobs)' : ''}`
      : '') + '.'
  );

  try {
    if (mode === 'sequential') {
      await runJobsSequential(jobs, opts, capturesRoot, puppeteer);
    } else if (mode === 'jobpool') {
      // peakBrowsers = min(requested, jobs.length) here — don't spawn idle
      // workers for jobs that don't exist.
      await runJobsParallel(jobs, opts, capturesRoot, puppeteer, peakBrowsers);
    } else {
      await runJobsFrameSharded(jobs, opts, capturesRoot, puppeteer, peakBrowsers);
    }

    console.log('\nAll animations recorded.');
  } finally {
    if (!opts.skipFfmpeg) {
      try {
        fs.rmSync(capturesRoot, { recursive: true, force: true });
      } catch (err) {
        console.warn('Could not remove captures dir:', err.message);
      }
    }
    // pasteTempDir is cleaned by the process.on('exit') handler registered
    // when it was created (fires on early exits too), so no cleanup here.
  }
}

main().catch((err) => {
  console.error('\nERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
