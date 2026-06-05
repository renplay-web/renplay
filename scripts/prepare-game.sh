#!/usr/bin/env bash
# Usage: ./scripts/prepare-game.sh <game-project-dir> <renpy-sdk-path> [output-name]
#
# Prepares a Ren'Py game project for Renplay:
#   1. Extracts and removes all .rpa archives (required for progressive download)
#   2. Creates progressive_download.txt if missing
#   3. Runs the SDK web build
#   4. Copies the output into games/<output-name>/
set -euo pipefail

GAME_DIR="${1:-}"
SDK_PATH="${2:-}"
OUTPUT_NAME="${3:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RENPLAY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  echo "Usage: $0 <game-project-dir> <renpy-sdk-path> [output-name]"
  echo ""
  echo "  game-project-dir  Path to the Ren'Py project (contains game/, renpy/, etc.)"
  echo "  renpy-sdk-path    Path to the Ren'Py SDK directory (contains renpy.sh)"
  echo "  output-name       Folder name in games/ (default: basename of game-project-dir)"
  exit 1
}

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "  $*"; }

[ -z "$GAME_DIR" ] && usage
[ -z "$SDK_PATH" ] && usage

GAME_DIR="$(cd "$GAME_DIR" && pwd)"
SDK_PATH="$(cd "$SDK_PATH" && pwd)"

[ -d "$GAME_DIR/game" ] || die "'$GAME_DIR' does not look like a Ren'Py project (no game/ subdirectory)"
[ -f "$SDK_PATH/renpy.sh" ] || die "'$SDK_PATH' does not look like a Ren'Py SDK (no renpy.sh)"

if [ -z "$OUTPUT_NAME" ]; then
  OUTPUT_NAME="$(basename "$GAME_DIR")"
fi

OUTPUT_NAME="$(echo "$OUTPUT_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/_/g')"
OUTPUT_DIR="$RENPLAY_ROOT/games/$OUTPUT_NAME"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

echo ""
echo "Game:    $GAME_DIR"
echo "SDK:     $SDK_PATH"
echo "Output:  $OUTPUT_DIR"
echo ""

# Step 1: Extract and remove .rpa archives
echo "Step 1/4: Extracting RPA archives..."
RPA_FILES="$(find "$GAME_DIR/game" -name '*.rpa' 2>/dev/null || true)"
if [ -z "$RPA_FILES" ]; then
  info "No .rpa archives found, skipping."
else
  if ! command -v unrpa >/dev/null 2>&1; then
    die "'unrpa' is not installed. Install it with: pip install unrpa"
  fi
  echo "$RPA_FILES" | while IFS= read -r rpa; do
    info "Extracting $(basename "$rpa")..."
    unrpa -p "$(dirname "$rpa")" "$rpa"
    rm "$rpa"
    info "Removed $rpa"
  done
  REMAINING="$(find "$GAME_DIR/game" -name '*.rpa' 2>/dev/null || true)"
  [ -z "$REMAINING" ] || die "Some .rpa files could not be removed: $REMAINING"
  info "All archives extracted and removed."
fi

# Step 2: Create progressive_download.txt if missing
echo ""
echo "Step 2/4: Checking progressive_download.txt..."
PDL="$GAME_DIR/progressive_download.txt"
if [ -f "$PDL" ]; then
  info "Found existing progressive_download.txt, using it."
else
  info "Creating default progressive_download.txt..."
  cat > "$PDL" << 'EOF'
# Keep GUI assets in the boot zip (needed before game starts)
- image game/gui/**

# Stream large asset directories on demand
+ image game/images/**
+ music game/music/**
+ music game/audio/**
+ voice game/voice/**
EOF
  info "Created $PDL"
  info "(Edit this file to tune which assets stream vs. load at boot)"
fi

# Step 3: Run the web build
echo ""
echo "Step 3/4: Running Ren'Py web build..."
"$SDK_PATH/renpy.sh" "$SDK_PATH/launcher" web_build "$GAME_DIR" --destination "$BUILD_DIR"
info "Build complete."

# Step 4: Copy to games/
echo ""
echo "Step 4/4: Installing to $OUTPUT_DIR..."
if [ -d "$OUTPUT_DIR" ]; then
  info "Removing existing $OUTPUT_DIR..."
  rm -rf "$OUTPUT_DIR"
fi
mkdir -p "$OUTPUT_DIR"
cp -r "$BUILD_DIR"/. "$OUTPUT_DIR/"
info "Installed."

echo ""
echo "Done. Open the Renplay admin panel and click 'Scan for new games'."
echo "Game will appear as: $OUTPUT_NAME"
echo ""
