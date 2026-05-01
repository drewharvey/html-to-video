#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PKG = require('./package.json');
const VERSION = PKG.version || '0.0.0';

const DEFAULTS = {
  fps: 60,
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

const CAPTURE_FORMATS = new Set(['jpeg', 'png']);
const CAPTURE_EXT_FOR_FORMAT = { jpeg: 'jpg', png: 'png' };

const VIDEO_CODECS = new Set(['libx264', 'libx265', 'libvpx-vp9', 'prores_ks']);
const VIDEO_CONTAINERS = new Set(['mp4', 'mov', 'webm']);

// Default container per codec, plus the full set of containers each
// codec is allowed to land in. ProRes outside .mov breaks most NLEs;
// VP9 outside .webm is fragile across players. Keep the matrix tight.
const DEFAULT_CONTAINER_FOR_CODEC = {
  libx264: 'mp4',
  libx265: 'mp4',
  'libvpx-vp9': 'webm',
  prores_ks: 'mov',
};
const ALLOWED_CONTAINERS_FOR_CODEC = {
  libx264: new Set(['mp4', 'mov']),
  libx265: new Set(['mp4', 'mov']),
  'libvpx-vp9': new Set(['webm']),
  prores_ks: new Set(['mov']),
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
                                    every animation at the given paths
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
  --fps <N>           Frames per second (default: ${DEFAULTS.fps}).
  --width <N>         Viewport width in CSS pixels (default: ${DEFAULTS.width}).
  --height <N>        Viewport height in CSS pixels (default: ${DEFAULTS.height}).
  --scale <N>         Device scale factor (default: ${DEFAULTS.scale};
                      1280×720 × 3 = 4K).
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
                      libvpx-vp9, prores_ks. h264 is the universal default;
                      h265 gives ~30% smaller files; vp9 targets web
                      delivery; prores_ks produces editing-friendly masters.
                      Default depends on --quality-preset.
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
  --concurrency <N>   How many animations to record in parallel (default
                      1). Each parallel slot launches its own browser, so
                      memory scales linearly. Useful for batches; for a
                      single animation it has no effect. Suggested: 3 on
                      8 GB, 8 on 16 GB, 12 on 32 GB+ (CPU cores cap
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

REVIEW FLAGS
  --out <path>        Write the review page to this path instead of a
                      tmpfile (implies --keep).
  --no-open           Don't auto-open the browser; just print the path.
                      (No auto-cleanup either.)
  --keep              Don't delete the temp file on exit. (Implied by
                      --out and --no-open.)

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
  if (command !== 'export' && command !== 'review') {
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
    width: DEFAULTS.width,
    height: DEFAULTS.height,
    scale: DEFAULTS.scale,
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
    container: null,
    qualityPreset: 'standard',
    skipFfmpeg: false,
    dryRun: false,
    skipOpen: false,
    keep: false,
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
    else if (a === '--fps') opts.fps = parsePositiveInt(requireValue('--fps'), '--fps');
    else if (a === '--width') opts.width = parsePositiveInt(requireValue('--width'), '--width');
    else if (a === '--height') opts.height = parsePositiveInt(requireValue('--height'), '--height');
    else if (a === '--scale') opts.scale = parsePositiveInt(requireValue('--scale'), '--scale');
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
    else if (a === '--no-ffmpeg') opts.skipFfmpeg = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-open') opts.skipOpen = true;
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
    frames.push({
      id: attrs.id,
      title: attrs.title || attrs.id,
      durationSeconds: parseFloat(durMatch[1]),
      html: m[2],
      declaredThemes: parseThemeList(attrs.themes || ''),
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
        for (const theme of themes) {
          jobs.push(makeJob({
            inputPath, inputBase,
            mode: 'bundle',
            bundleId: frame.id,
            bundleTitle: frame.title,
            bundleHtml: frame.html,
            durationSeconds,
            durationSource,
            theme,
          }, opts));
        }
      }
    } else {
      const meta = extractMetaDuration(text);
      const declaredThemes = extractDeclaredThemes(text);
      const durationSeconds = opts.durationExplicit
        ? opts.duration
        : (meta != null ? meta : opts.duration);
      const durationSource = opts.durationExplicit
        ? 'flag'
        : (meta != null ? 'meta' : 'default');
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
          theme,
        }, opts));
      }
    }
  }
  return jobs;
}

function makeJob(j, opts) {
  const totalFrames = Math.max(1, Math.round(j.durationSeconds * opts.fps));
  const themeSuffix = j.theme ? '-' + j.theme : '';
  const captureKey = j.mode === 'bundle'
    ? `${j.inputBase}__${j.bundleId}${themeSuffix}`
    : `${j.inputBase}${themeSuffix}`;
  return {
    ...j,
    totalFrames,
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
    console.log(
      `  ${job.label.padEnd(34)} ${dur.padStart(6)} × ${opts.fps}fps = ` +
      `${String(job.totalFrames).padStart(5)} frames → ${out}${src}`
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
//    - `requestAnimationFrame` callback timestamps are scaled the same way
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
  var rRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function(cb) {
    return rRAF(function(realTs) { cb((realTs - perfStart) / sf); });
  };
})`;

// =========================================================================
// Recording
// =========================================================================

async function recordJob(browser, job, opts, capturesRoot) {
  const page = await browser.newPage();
  try {
    await page.setViewport({
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: opts.scale,
    });

    // Inject the JS time-slowdown shim before any page script runs.
    await page.evaluateOnNewDocument(`${SHIM_SOURCE}(${opts.slowdown});`);

    if (job.mode === 'bundle') {
      await page.setContent(job.bundleHtml, { waitUntil: 'load' });
    } else {
      await page.goto('file://' + job.inputPath, { waitUntil: 'load' });
    }

    // Slow CSS animations / transitions / Web Animations API entries
    // proportionally. Must be set after navigation so the timeline exists.
    const client = await page.target().createCDPSession();
    await client.send('Animation.enable');
    if (opts.slowdown !== 1) {
      await client.send('Animation.setPlaybackRate', {
        playbackRate: 1 / opts.slowdown,
      });
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

    const captureDir = path.join(capturesRoot, job.captureKey);
    fs.rmSync(captureDir, { recursive: true, force: true });
    fs.mkdirSync(captureDir, { recursive: true });

    const captureExt = CAPTURE_EXT_FOR_FORMAT[opts.captureFormat];
    const screenshotOpts = opts.captureFormat === 'png'
      ? { type: 'png' }
      : { type: 'jpeg', quality: opts.captureQuality };

    // Pace screenshots at S × frame-interval real ms.
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
      if (!opts.quietProgress && (i % opts.fps === 0 || i === job.totalFrames)) {
        process.stdout.write(`\r    captured ${i}/${job.totalFrames}`);
      }
    }
    if (!opts.quietProgress) process.stdout.write('\n');
    return captureDir;
  } finally {
    try { await page.close(); } catch { /* ignore cleanup errors */ }
  }
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
    case 'prores_ks': {
      // Profile 4 = ProRes 4444 (12-bit 4:4:4) for max tier. Profile 3 =
      // HQ (10-bit 4:2:2) for everything else — the editing-friendly
      // default. -vendor apl0 marks the file as Apple-vendor ProRes,
      // which some pickier NLEs require. ProRes ignores --crf entirely.
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

function ffmpegStitch(captureDir, outPath, opts) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const captureExt = CAPTURE_EXT_FOR_FORMAT[opts.captureFormat];
    // -movflags +faststart reorders the moov atom to the start of the
    // file so playback can begin while the file is still downloading.
    // Critical for web embedding; harmless for local playback. Only
    // applies to mp4/mov; webm is a Matroska variant with its own seek
    // index.
    const faststart = (opts.container === 'mp4' || opts.container === 'mov')
      ? ['-movflags', '+faststart'] : [];
    const args = [
      '-y',
      '-loglevel', 'error',
      '-framerate', String(opts.fps),
      '-start_number', '1',
      '-i', path.join(captureDir, '%04d.' + captureExt),
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
// Build a single self-contained HTML page that embeds every animation
// from the given paths as <iframe srcdoc>. Default: write to a tmpfile,
// open it in the browser, wait for SIGINT, delete on exit.

function safeJsonForScript(value) {
  // JSON.stringify produces literal "</script>" inside any embedded
  // animation HTML, which would terminate the outer <script> tag.
  // Escape "</" → "<\/" — equivalent in a JS string, invisible to the
  // HTML tokenizer.
  return JSON.stringify(value, null, 2).replace(/<\/(?=[a-zA-Z!])/g, '<\\/');
}

function buildReviewHtml(animations) {
  const count = animations.length;
  const countLabel = `${count} animation${count === 1 ? '' : 's'}`;
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>h2v review — ${countLabel}</title>
<style>
:root {
  --bg: #0b0b0c; --card-bg: #161618; --border: #2a2a2d;
  --text: #e6e6e8; --muted: #9a9aa1; --accent: #056ff0;
  --btn-bg: #1f1f23; --btn-hover: #2a2a30;
}
[data-theme="light"] {
  --bg: #f4f4f5; --card-bg: #ffffff; --border: #d8d8dc;
  --text: #18181b; --muted: #6a6a72; --accent: #056ff0;
  --btn-bg: #ececef; --btn-hover: #dedee2;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg); color: var(--text);
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  min-height: 100vh; transition: background 0.2s ease, color 0.2s ease;
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
.global-controls { display: flex; gap: 8px; }
button.ctl {
  padding: 8px 14px; background: var(--btn-bg); border: 1px solid var(--border);
  border-radius: 8px; color: var(--text); font-size: 13px; cursor: pointer;
  font-family: monospace;
}
button.ctl:hover { background: var(--btn-hover); }
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
.card-head .replay {
  padding: 6px 12px; font-size: 12px; background: var(--btn-bg);
  border: 1px solid var(--border); border-radius: 6px; color: var(--text);
  cursor: pointer; font-family: monospace;
}
.card-head .replay:hover { background: var(--btn-hover); }
.frame-iframe {
  display: block; width: 100%; height: 480px; border: 0;
  background: var(--bg);
}
</style>
</head>
<body>
<header class="page-header">
  <h1>h2v review <small>${countLabel}</small></h1>
  <div class="global-controls">
    <button class="ctl" id="reloadAll">↻ Reload all</button>
    <button class="ctl" id="themeToggle">☀ Light</button>
  </div>
</header>
<main id="cards"></main>
<script>
const ANIMATIONS = ${safeJsonForScript(animations)};

let currentTheme = 'dark';

function injectTheme(html, theme) {
  const stripped = html.replace(/<html\\b([^>]*?)\\sdata-theme="[^"]*"([^>]*)>/i, '<html$1$2>');
  return stripped.replace(/<html\\b([^>]*)>/i, '<html$1 data-theme="' + theme + '">');
}
function loadFrame(iframe, html) { iframe.srcdoc = injectTheme(html, currentTheme); }
function broadcastTheme(theme) {
  document.querySelectorAll('iframe').forEach((f) => {
    try { f.contentWindow && f.contentWindow.postMessage({ theme: theme }, '*'); } catch (_) {}
  });
}
function setThemeButtonLabel() {
  document.getElementById('themeToggle').textContent =
    currentTheme === 'dark' ? '☀ Light' : '🌙 Dark';
}

const main = document.getElementById('cards');
ANIMATIONS.forEach((a) => {
  const card = document.createElement('article');
  card.className = 'card';
  const head = document.createElement('div');
  head.className = 'card-head';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = a.title || a.id;
  const source = document.createElement('span');
  source.className = 'source';
  source.textContent = a.source;
  const replay = document.createElement('button');
  replay.className = 'replay';
  replay.textContent = '↺ Replay';
  const iframe = document.createElement('iframe');
  iframe.className = 'frame-iframe';
  iframe.title = a.title || a.id;
  iframe.setAttribute('loading', 'lazy');
  replay.addEventListener('click', () => loadFrame(iframe, a.html));
  loadFrame(iframe, a.html);
  head.append(name, source, replay);
  card.append(head, iframe);
  main.appendChild(card);
});

document.getElementById('reloadAll').addEventListener('click', () => {
  document.querySelectorAll('.card').forEach((card, i) => {
    const iframe = card.querySelector('iframe');
    loadFrame(iframe, ANIMATIONS[i].html);
  });
});
document.getElementById('themeToggle').addEventListener('click', () => {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', currentTheme);
  setThemeButtonLabel();
  broadcastTheme(currentTheme);
});
setThemeButtonLabel();
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
        });
      }
    } else {
      animations.push({
        id: inputBase,
        title: null,
        source: inputBase,
        html: text,
      });
    }
  }
  return animations;
}

async function runReview(paths, opts) {
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

  const html = buildReviewHtml(animations);

  const isTempFile = !opts.outOverride;
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
// Memory budget heuristic
// =========================================================================
//
// Rough rule of thumb: a headless Chrome's RSS at our settings is dominated
// by browser baseline (~150 MB) plus the capture surface, which scales
// roughly with megapixels (~30 MB/MP). At 4K (3840×2160 ≈ 8.3 MP) this
// gives ~400 MB, matching what we observed in tests/bench-parallel.js.
// The constants are deliberately approximate — false positives are
// preferable to silent OOMs, and the warning is non-blocking either way.

function estimateWorkerMemoryMb(opts) {
  const mp = (opts.width * opts.scale) * (opts.height * opts.scale) / 1e6;
  return Math.round(150 + 30 * mp);
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

function checkMemoryBudget(opts, concurrency) {
  const perWorker = estimateWorkerMemoryMb(opts);
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
        await ffmpegStitch(captureDir, outPath, opts);
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
        const captureDir = await recordJob(browser, job, workerOpts, capturesRoot);
        if (!opts.skipFfmpeg) {
          const outPath = outputPathFor(job, opts);
          await ffmpegStitch(captureDir, outPath, opts);
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

// =========================================================================
// Main
// =========================================================================

async function main() {
  const { paths, opts } = parseArgs(process.argv);

  if (opts.command === 'review') {
    return runReview(paths, opts);
  }

  resolveExportOpts(opts);

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

  // Memory-budget warning fires in dry-run too — users may want to preview
  // whether a planned --concurrency setting will fit before committing.
  const concurrency = Math.min(opts.concurrency, jobs.length);
  checkMemoryBudget(opts, concurrency);

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
  const proresProfile = tier === 'max' ? '4 (4444)' : '3 (HQ)';
  const codecDesc = opts.codec === 'prores_ks'
    ? `${opts.codec} profile ${proresProfile}`
    : `${opts.codec} crf ${opts.crf}`;
  console.log(
    `\nRecording at ${opts.width * opts.scale}×${opts.height * opts.scale} ` +
    `(${opts.width}×${opts.height} × ${opts.scale}), ${opts.fps}fps, ` +
    `preset ${tier}: capture ${captureDesc}, ${codecDesc} → .${opts.container}, ` +
    `slowdown ${opts.slowdown}× (wall time = animation × ${opts.slowdown})` +
    (concurrency > 1 ? `, concurrency ${concurrency}` : '') + '.'
  );

  try {
    if (concurrency === 1) {
      await runJobsSequential(jobs, opts, capturesRoot, puppeteer);
    } else {
      await runJobsParallel(jobs, opts, capturesRoot, puppeteer, concurrency);
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
  }
}

main().catch((err) => {
  console.error('\nERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
