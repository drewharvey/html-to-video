#!/usr/bin/env bash
#
# bench-alpha-codec.sh — compare alpha-capable encodings of the same content.
#
# Usage:
#   ./tests/bench-alpha-codec.sh [path-to-html]
#   ./tests/bench-alpha-codec.sh --paste            # reads HTML from stdin
#   pbpaste | ./tests/bench-alpha-codec.sh --paste  # pipe clipboard in
#
#   Defaults to tests/bench-alpha-codec.fixture.html — the real-world
#   badges animation that exhibited the CapCut white-background failure.
#   The fixture's h2v-viewport meta is honoured; duration is FORCED to
#   BENCH_DURATION_SECS (default 20s) regardless of the fixture's
#   h2v-duration meta, so every bench output matches or exceeds the
#   profile of the problematic real-world export (4K 30fps 17s). h2v
#   default scale (3 → 4K) and fps (30, the --alpha default) are used.
#
#   Override the forced duration via env var:
#     BENCH_DURATION_SECS=30 ./tests/bench-alpha-codec.sh --paste
#
# What it does:
#   1. Captures frames once from the given HTML via h2v --alpha
#      (transparent background, alpha-preserving PNG capture).
#   2. Re-encodes those exact frames with every alpha-capable codec
#      and every alpha-mode (straight / pre-multiplied).
#   3. Drops the results in output/alpha-bench/ for you to test in your NLE.
#
# What you do with the results:
#   Drag each .mov onto an NLE timeline. For each variant, confirm:
#     (a) it imports without any "interpret footage" dialog
#     (b) the alpha channel is auto-detected (transparent areas pass through)
#     (c) it looks identical to a reference (or your raw source intent)
#   Whichever pass all three for your NLE are the codecs we can ship in h2v.
#
# Approx run time: capture scales with BENCH_DURATION_SECS × slowdown (6×).
# For 20s at 4K that's ~120s wall time.

set -euo pipefail
cd "$(dirname "$0")/.."

# Force duration so every bench output is at or above the profile of the
# real-world failing export (4K 30fps 17s). Default 20s gives a 3s margin.
BENCH_DURATION_SECS="${BENCH_DURATION_SECS:-20}"

CLEANUP_PASTE_TMP=""
if [ "${1:-}" = "--paste" ]; then
  # Read HTML from stdin into a temp file so h2v can take a path argument.
  # h2v's own --paste flow does effectively the same thing.
  TMPDIR_PASTE=$(mktemp -d -t h2v-paste-XXXXXX)
  FIXTURE="$TMPDIR_PASTE/paste.html"
  cat > "$FIXTURE"
  if [ ! -s "$FIXTURE" ]; then
    echo "error: --paste got no HTML from stdin"
    echo "       try: pbpaste | $0 --paste"
    rm -rf "$TMPDIR_PASTE"
    exit 1
  fi
  CLEANUP_PASTE_TMP="$TMPDIR_PASTE"
  echo "→ Pasted HTML: $(wc -c <"$FIXTURE") bytes into $FIXTURE"
else
  FIXTURE="${1:-tests/bench-alpha-codec.fixture.html}"
  if [ ! -f "$FIXTURE" ]; then
    echo "error: fixture not found: $FIXTURE"
    echo "  pass an HTML path, or use --paste to read from stdin:"
    echo "    pbpaste | $0 --paste"
    exit 1
  fi
fi

# Clean up the paste tempdir on exit regardless of how the script ends
trap '[ -n "$CLEANUP_PASTE_TMP" ] && rm -rf "$CLEANUP_PASTE_TMP"' EXIT

OUT=output/alpha-bench
mkdir -p "$OUT"
rm -f "$OUT"/*.mov

# Capture key derived from the fixture's basename — matches h2v's own scheme
FIXTURE_BASE=$(basename "$FIXTURE" .html)
FRAMES="captures/$FIXTURE_BASE"

# -----------------------------------------------------------------------------
# 1. Capture frames once via h2v --alpha defaults. --no-ffmpeg leaves PNGs in
#    place so we can re-encode them N times below.
# -----------------------------------------------------------------------------
echo "→ Capturing frames from $FIXTURE at 4K 30fps ${BENCH_DURATION_SECS}s…"
rm -rf "$FRAMES"
# --duration overrides any h2v-duration meta in the fixture so the bench
# output always matches/exceeds the real-world problem file (4K 30fps 17s).
node cli.js export "$FIXTURE" --alpha --no-ffmpeg \
  --duration "$BENCH_DURATION_SECS" 2>&1 \
  | grep -E "Recording at|captured" || true

NUM_FRAMES=$(ls "$FRAMES" 2>/dev/null | wc -l | tr -d ' ')
if [ "$NUM_FRAMES" = "0" ]; then
  echo "  capture failed — no frames in $FRAMES"
  exit 1
fi

# Detect the capture dimensions
DIMS=$(ffprobe -v error -select_streams v -count_packets -show_entries \
  stream=width,height -of csv=p=0 "$FRAMES/0001.png")
echo "  $NUM_FRAMES frames captured at $DIMS"

# Discover frame rate from h2v's default for --alpha (30 fps)
FPS=30

# -----------------------------------------------------------------------------
# 2. Helper: encode and report size.
# -----------------------------------------------------------------------------
encode() {
  local label="$1"; local outname="$2"; shift 2
  local outpath="$OUT/$outname"
  printf "  %-50s " "$label"
  if ! ffmpeg -y -loglevel error -framerate "$FPS" -i "$FRAMES/%04d.png" "$@" \
       -movflags +faststart "$outpath" 2>/dev/null; then
    echo "FAILED"; return
  fi
  local sz_bytes; sz_bytes=$(wc -c <"$outpath")
  printf "%7.1f MB  →  %s\n" \
    "$(echo "scale=1; $sz_bytes/1048576" | bc -l)" \
    "$outpath"
}

# -----------------------------------------------------------------------------
# 3. Encode each candidate.
# -----------------------------------------------------------------------------
echo
echo "→ Encoding candidates:"

# qtrle variants (current h2v --alpha default — QuickTime Animation,
# RLE-lossless, decodes correctly in CapCut at 4K + long durations)
encode "01. qtrle pre-mult (h2v default)" \
  "$FIXTURE_BASE.01-qtrle-premult.mov" \
  -vf "premultiply=inplace=1" -c:v qtrle -pix_fmt argb

encode "02. qtrle straight" \
  "$FIXTURE_BASE.02-qtrle-straight.mov" \
  -c:v qtrle -pix_fmt argb

# PNG-in-MOV variants (previous h2v default — works in QuickTime/IINA/FCP
# but CapCut's PNG decoder drops alpha at 4K + long durations)
encode "03. PNG pre-mult (previous default)" \
  "$FIXTURE_BASE.03-png-premult.mov" \
  -vf "premultiply=inplace=1" -c:v png -pix_fmt rgba

encode "04. PNG straight" \
  "$FIXTURE_BASE.04-png-straight.mov" \
  -c:v png -pix_fmt rgba

# ProRes 4444 variants (original h2v default — Apple mastering codec,
# 5-10× larger files than qtrle/PNG)
encode "05. ProRes 4444 pre-mult" \
  "$FIXTURE_BASE.05-prores-premult.mov" \
  -vf "premultiply=inplace=1" -c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le -vendor apl0

encode "06. ProRes 4444 straight" \
  "$FIXTURE_BASE.06-prores-straight.mov" \
  -c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le -vendor apl0

# HEVC with alpha via VideoToolbox — macOS-only hardware encoder. Lossy but
# visually clean at -alpha_quality 0.75. Apple's HEVC-with-alpha format is
# always pre-multiplied per spec, so no -mode variants.
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q hevc_videotoolbox; then
  encode "07. HEVC w/ alpha (macOS only)" \
    "$FIXTURE_BASE.07-hevc-vt.mov" \
    -c:v hevc_videotoolbox -allow_sw 1 -alpha_quality 0.75 \
    -tag:v hvc1 -pix_fmt bgra
else
  echo "  07. HEVC w/ alpha (macOS only)                  skipped — hevc_videotoolbox not available"
fi

# -----------------------------------------------------------------------------
# 4. Cleanup captures dir; results stay in output/alpha-bench/.
# -----------------------------------------------------------------------------
rm -rf "$FRAMES"
rmdir captures 2>/dev/null || true

echo
echo "→ Done. Files to test, sorted by size:"
ls -laS "$OUT"/*.mov | awk '{ printf "    %7.1f MB  %s\n", $5/1048576, $NF }'
echo
echo "Drop each onto your NLE timeline. For each, check:"
echo "  • Imports cleanly (no 'interpret footage' dialog)"
echo "  • Alpha channel auto-detected"
echo "  • Visually correct (no white halos, no glow blow-out)"
