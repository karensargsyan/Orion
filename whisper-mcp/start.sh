#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export WHISPER_HOST="${WHISPER_HOST:-127.0.0.1}"
export WHISPER_PORT="${WHISPER_PORT:-8888}"
export WHISPER_MODEL="${WHISPER_MODEL:-distil-large-v3}"
export WHISPER_BATCH="${WHISPER_BATCH:-16}"
exec .venv/bin/python server.py
