"""
OpenAI-compatible /v1/audio/transcriptions + MCP (streamable HTTP) on the same port.

Listen: 127.0.0.1:8888
MCP URL: http://127.0.0.1:8888/mcp
Extension: base URL http://localhost:8888 (POST /v1/audio/transcriptions)
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from subprocess import CalledProcessError

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse
from mcp.server.fastmcp import FastMCP

from transcription_service import ensure_model, get_model_info, transcribe_path, transcribe_uploaded_bytes

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("whisper-mcp")

HOST = os.environ.get("WHISPER_HOST", "127.0.0.1")
PORT = int(os.environ.get("WHISPER_PORT", "8888"))


@asynccontextmanager
async def lifespan(_: FastAPI):
    logger.info("Warming up MLX model (first run may download weights)…")
    await asyncio.to_thread(ensure_model)
    logger.info("Listening on http://%s:%s — MCP: /mcp", HOST, PORT)
    yield


app = FastAPI(title="Whisper MLX", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok", **get_model_info()}


@app.post("/v1/audio/transcriptions")
async def openai_transcriptions(
    file: UploadFile = File(...),
    model: str = Form(default="whisper-1"),
    response_format: str = Form(default="json"),
    language: str | None = Form(default=None),
):
    del model  # OpenAI compatibility; local engine uses WHISPER_MODEL env
    if response_format not in ("json", "text", "verbose_json"):
        raise HTTPException(400, "Unsupported response_format")
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty file")
    suffix = Path(file.filename or "audio.webm").suffix or ".webm"
    lang = language if language else None
    try:
        text = await transcribe_uploaded_bytes(raw, suffix)
    except CalledProcessError as e:
        logger.warning("ffmpeg failed: %s", getattr(e, "stderr", e))
        raise HTTPException(500, "Audio decode failed") from e
    except Exception as e:
        logger.exception("Transcription failed")
        raise HTTPException(500, "Transcription failed") from e

    if response_format == "text":
        return PlainTextResponse(text)
    return JSONResponse({"text": text})


def subprocess_error():
    from subprocess import CalledProcessError

    return CalledProcessError


# --- MCP (mount at /mcp) ------------------------------------------------------

mcp = FastMCP(
    "Local Whisper",
    instructions=(
        "Apple Silicon MLX Whisper server. transcribe_file(path) transcribes a local audio file. "
        "For browser/extension capture, use the HTTP API POST /v1/audio/transcriptions on port "
        f"{PORT}. Check whisper_status() for the active model."
    ),
    streamable_http_path="/",
    host=HOST,
    port=PORT,
)


@mcp.tool()
async def transcribe_file(path: str) -> str:
    """Transcribe audio from a local file path (wav, mp3, m4a, webm, etc.)."""
    p = Path(path).expanduser().resolve()
    if not p.is_file():
        return f"Error: file not found: {path}"
    try:
        return await transcribe_path(p)
    except Exception as e:
        return f"Error: {e!s}"


@mcp.tool()
def whisper_status() -> dict:
    """Return loaded model name, batch size, and weights directory."""
    ensure_model()
    return get_model_info()


app.mount("/mcp", mcp.streamable_http_app())


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server:app",
        host=HOST,
        port=PORT,
        log_level="info",
        access_log=True,
        loop="uvloop",
    )
