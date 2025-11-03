#!/usr/bin/env bash
set -euo pipefail

# Run the CLI in Docker with sane defaults for macOS/Apple Silicon hosts.
# - Forces linux/amd64 (odiff binary support)
# - Increases shared memory for Chromium
# - Mounts only visual-regression directory to avoid masking container deps

ROOT_DIR="$(cd "$(dirname "$0")"/.. && pwd)"

docker build --platform=linux/amd64 -t storybook-visual-regression "$ROOT_DIR"

docker run --platform=linux/amd64 --rm \
  --shm-size=1g \
  -p 9009:9009 \
  -v "$ROOT_DIR/visual-regression":/work/visual-regression \
  -w /work \
  storybook-visual-regression "$@"


