#!/usr/bin/env bash
# Generates a short, silent, synthetic MP4 for exercising the admin upload -> transcode ->
# publish flow without needing a real video file lying around. Pure ffmpeg test sources
# (no external assets), so this works offline.
#
# Usage: bash scripts/generate-sample-video.sh [output-path] [duration-seconds]

set -euo pipefail

OUT="${1:-./sample-video.mp4}"
DURATION="${2:-30}"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required. Install it (e.g. 'apt install ffmpeg' / 'brew install ffmpeg') or run:" >&2
  echo "  docker compose exec worker sh -c 'ffmpeg ...'  (the worker image already has it)" >&2
  exit 1
fi

echo "Generating a ${DURATION}s sample video at ${OUT}…"

ffmpeg -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=${DURATION}" \
  -f lavfi -i "sine=frequency=440:duration=${DURATION}" \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p \
  -c:a aac -b:a 128k \
  -movflags +faststart \
  "${OUT}"

echo "Done: ${OUT}"
echo "Upload it from the admin panel: Titles -> New title -> save -> Video -> Upload & transcode."
