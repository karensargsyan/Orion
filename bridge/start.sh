#!/bin/bash
# Start the MemPalace bridge using the project venv.
# Run from the extension repo root: ./bridge/start.sh

DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$DIR/.venv"

if [ ! -f "$VENV/bin/python3" ]; then
  echo "Creating venv and installing mempalace..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet mempalace
fi

echo "Starting MemPalace bridge..."
exec "$VENV/bin/python3" "$DIR/mempalace_bridge.py"
