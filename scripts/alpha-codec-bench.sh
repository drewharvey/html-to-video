#!/usr/bin/env bash
#
# alpha-codec-bench.sh — compare alpha-capable encodings of the same content.
#
# What it does:
#   1. Captures frames once from tests/alpha-test.html at 4K 24fps via h2v
#      (transparent background, alpha-preserving PNG capture).
#   2. Re-encodes those exact frames with every alpha-capable codec.
#   3. Drops the results in output/alpha-bench/ for you to test in your NLE.
#
# What you do with the results:
#   Drag each .mov onto an NLE timeline (Premiere, Resolve, FCP, AE).
#   Confirm that:
#     (a) the file imports without any "interpret footage" dialog
#     (b) the alpha channel is auto-detected (transparent areas show through)
#     (c) it looks identical to the prores4444 baseline
#   Whichever pass all three are the codecs we can ship in h2v.
#
# Approx run time: ~30 s on a recent Mac. Capture is the slow part.

set -euo pipefail
cd "$(dirname "$0")/.."

FIXTURE=tests/alpha-test.html
OUT=output/alpha-bench
FRAMES=captures/alpha-test

mkdir -p "$OUT"
rm -f "$OUT"/*.mov

# -----------------------------------------------------------------------------
# 1. Capture frames once at 4K 24fps. --alpha sets omitBackground:true so the
#    body's transparent style is preserved; --no-ffmpeg leaves PNGs in place
#    so we can re-encode them N times below.
# -----------------------------------------------------------------------------
echo "→ Capturing frames from $FIXTURE at 4K 24fps…"
rm -rf "$FRAMES"
node cli.js export "$FIXTURE" --alpha --fps 24 --no-ffmpeg \
  | grep -E "captured|Recording at" || true

NUM_FRAMES=$(ls "$FRAMES" 2>/dev/null | wc -l | tr -d ' ')
if [ "$NUM_FRAMES" = "0" ]; then
  echo "  capture failed — no frames in $FRAMES"
  exit 1
fi
echo "  $NUM_FRAMES frames captured at 3840×2160"

# -----------------------------------------------------------------------------
# 2. Helper: encode and report size.
# -----------------------------------------------------------------------------
encode() {
  local label="$1"; local outname="$2"; shift 2
  local outpath="$OUT/$outname"
  printf "→ %-30s " "$label"
  if ! ffmpeg -y -loglevel error -framerate 24 -i "$FRAMES/%04d.png" "$@" \
       -movflags +faststart "$outpath" 2>/dev/null; then
    echo "FAILED"
    return
  fi
  # macOS uses -f%z, Linux uses -c%s; wc -c is portable
  local sz_bytes; sz_bytes=$(wc -c <"$outpath")
  printf "%7.1f MB  →  %s\n" "$(echo "scale=1; $sz_bytes/1048576" | bc -l)" "$outpath"
}

# -----------------------------------------------------------------------------
# 3. Encode each candidate.
#    File-naming convention: alpha-test.<codec>.mov, sorted-friendly.
# -----------------------------------------------------------------------------
echo
echo "→ Encoding candidates:"

# A. PNG-in-MOV, pre-multiplied — the h2v --alpha default.
encode "PNG-in-MOV pre-mult (h2v default)"  "alpha-test.01-png-premult.mov" \
  -vf "premultiply=inplace=1" -c:v png -pix_fmt rgba

# B. PNG-in-MOV, straight alpha — opt-out via --alpha-mode straight.
encode "PNG-in-MOV straight (--alpha-mode)" "alpha-test.02-png-straight.mov" \
  -c:v png -pix_fmt rgba

# C. ProRes 4444, pre-multiplied — opt-in via --codec prores_ks.
encode "ProRes 4444 pre-mult (codec opt-in)" "alpha-test.03-prores-premult.mov" \
  -vf "premultiply=inplace=1" -c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le -vendor apl0

# D. ProRes 4444, straight — only useful if your tool explicitly wants straight.
encode "ProRes 4444 straight"               "alpha-test.04-prores-straight.mov" \
  -c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le -vendor apl0

# E. QuickTime Animation (qtrle) — alternative lossless codec.
encode "qtrle (lossless)"                   "alpha-test.05-qtrle.mov" \
  -c:v qtrle -pix_fmt argb

# F. HEVC with alpha via VideoToolbox — macOS-only hardware encoder.
#    Lossy but visually clean at -alpha_quality 0.75. Often dramatically
#    smaller than even the lossless options. Skipped on non-macOS hosts.
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q hevc_videotoolbox; then
  encode "HEVC w/ alpha (macOS)"            "alpha-test.06-hevc-vt.mov" \
    -c:v hevc_videotoolbox -allow_sw 1 -alpha_quality 0.75 \
    -tag:v hvc1 -pix_fmt bgra
else
  echo "→ HEVC w/ alpha (macOS)                  skipped — hevc_videotoolbox not available"
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
echo "Drop each onto your NLE timeline. Look for:"
echo "  • Imports cleanly (no 'interpret footage' dialog)"
echo "  • Alpha channel auto-detected (transparent areas pass through)"
echo "  • Visually identical to the prores4444 baseline"
