"""MLX Whisper inference with serialized access and ffmpeg preprocessing."""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import tempfile
from pathlib import Path

from lightning_whisper_mlx import LightningWhisperMLX

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent
_infer_lock = asyncio.Lock()
_model: LightningWhisperMLX | None = None


def _model_name() -> str:
    return os.environ.get("WHISPER_MODEL", "distil-large-v3")


def _batch_size() -> int:
    return int(os.environ.get("WHISPER_BATCH", "16"))


def get_model_info() -> dict[str, str | int]:
    return {
        "model": _model_name(),
        "batch_size": _batch_size(),
        "mlx_models_dir": str(ROOT / "mlx_models"),
    }


def ensure_model() -> LightningWhisperMLX:
    """Load model once; LightningWhisperMLX stores weights under ./mlx_models relative to cwd."""
    global _model
    if _model is not None:
        return _model
    os.chdir(ROOT)
    name = _model_name()
    bs = _batch_size()
    logger.info("Loading Whisper model %s (batch_size=%s)…", name, bs)
    _model = LightningWhisperMLX(model=name, batch_size=bs, quant=None)
    logger.info("Model ready.")
    return _model


def _ffmpeg_to_wav_16k_mono(src: Path) -> Path:
    dst = src.with_suffix(".16k.wav")
    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(src),
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        str(dst),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return dst


def _transcribe_wav_path(wav: Path, language: str | None) -> str:
    model = ensure_model()
    out = model.transcribe(str(wav), language=language)
    return (out.get("text") or "").strip()


async def transcribe_path(audio_path: Path, language: str | None = None) -> str:
    """Transcribe an audio file (any format ffmpeg accepts)."""
    wav = await asyncio.to_thread(_ffmpeg_to_wav_16k_mono, audio_path)
    try:
        async with _infer_lock:
            text = await asyncio.to_thread(_transcribe_wav_path, wav, language)
        return text
    finally:
        try:
            wav.unlink(missing_ok=True)
        except OSError:
            pass


async def transcribe_uploaded_bytes(data: bytes, suffix: str) -> str:
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix, dir=ROOT) as tmp:
        tmp.write(data)
        path = Path(tmp.name)
    try:
        return await transcribe_path(path)
    finally:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
