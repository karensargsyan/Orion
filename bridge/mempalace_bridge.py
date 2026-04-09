#!/usr/bin/env python3
"""
MemPalace Bridge — local HTTP server connecting the LocalAI browser extension
to the MemPalace Python library for *permanent* memory.

Endpoints:
  GET  /health            — check bridge + mempalace package status
  POST /search            — semantic search across the palace
  POST /store             — directly write a memory (drawer) into the palace
  POST /store-batch       — write multiple memories at once

The extension calls /store every time it observes an error, a success, a lesson,
or an important pattern — so the AI never forgets.

Requirements:
  pip install mempalace   (inside bridge/.venv)

Run:
  python3 bridge/mempalace_bridge.py
  # or use the start script: ./bridge/start.sh
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional, Tuple
from urllib.parse import urlparse

HOST = os.environ.get("MEMPALACE_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("MEMPALACE_BRIDGE_PORT", "8765"))

DEFAULT_PALACE = os.path.expanduser(
    os.environ.get("MEMPALACE_PALACE_PATH", "~/.mempalace/palace")
)

_collection_cache: Any = None
_collection_ts: float = 0.0


def palace_path() -> str:
    return os.path.expanduser(
        os.environ.get("MEMPALACE_PALACE_PATH", DEFAULT_PALACE)
    )


def _get_collection() -> Any:
    """Lazy-cached ChromaDB collection handle."""
    global _collection_cache, _collection_ts
    now = time.time()
    if _collection_cache is not None and now - _collection_ts < 300:
        return _collection_cache
    from mempalace.miner import get_collection  # type: ignore
    _collection_cache = get_collection(palace_path())
    _collection_ts = now
    return _collection_cache


def _ensure_palace() -> None:
    p = palace_path()
    os.makedirs(p, exist_ok=True)
    cfg = os.path.expanduser("~/.mempalace/config.json")
    if not os.path.exists(cfg):
        os.makedirs(os.path.dirname(cfg), exist_ok=True)
        with open(cfg, "w") as f:
            json.dump({"palace_path": p, "collection_name": "mempalace_drawers"}, f)


# ── Search ──────────────────────────────────────────────────────────────────────

def do_search(
    query: str,
    wing: Optional[str] = None,
    room: Optional[str] = None,
    limit: int = 8,
) -> Tuple[Optional[str], Optional[str]]:
    try:
        from mempalace.searcher import search_memories  # type: ignore
    except ImportError:
        return None, "mempalace not installed"

    try:
        out = search_memories(
            query, palace_path=palace_path(), wing=wing, room=room, n_results=limit
        )
    except Exception:
        return None, traceback.format_exc()

    return _fmt(out), None


def _fmt(out: Any) -> str:
    if out is None:
        return ""
    if isinstance(out, str):
        return out.strip()
    if isinstance(out, dict):
        docs = out.get("documents") or out.get("results") or []
        if isinstance(docs, list) and docs:
            if isinstance(docs[0], list):
                docs = docs[0]
            lines = []
            metas = out.get("metadatas", [[]])[0] if "metadatas" in out else [{}] * len(docs)
            for i, (doc, meta) in enumerate(zip(docs, metas), 1):
                wing_tag = meta.get("wing", "") if isinstance(meta, dict) else ""
                room_tag = meta.get("room", "") if isinstance(meta, dict) else ""
                prefix = f"[{wing_tag}/{room_tag}] " if wing_tag else ""
                lines.append(f"{i}. {prefix}{str(doc)[:1200]}")
            return "\n".join(lines).strip()
        return json.dumps(out, default=str)[:6000]
    if isinstance(out, list):
        return "\n".join(f"{i}. {str(x)[:1200]}" for i, x in enumerate(out[:20], 1))
    return str(out)[:6000]


# ── Store (direct palace ingest) ────────────────────────────────────────────────

_chunk_counter: int = 0


def do_store(
    wing: str,
    room: str,
    content: str,
    source: str = "extension",
    agent: str = "localai_assistant",
) -> Tuple[bool, Optional[str]]:
    global _chunk_counter
    if not content.strip():
        return False, "empty_content"
    try:
        _ensure_palace()
        col = _get_collection()
        from mempalace.miner import add_drawer  # type: ignore
        _chunk_counter += 1
        add_drawer(col, wing, room, content, source, _chunk_counter, agent)
        return True, None
    except Exception:
        return False, traceback.format_exc()


def do_store_batch(
    entries: list[dict[str, Any]],
) -> Tuple[int, Optional[str]]:
    ok_count = 0
    last_err = None
    for e in entries:
        w = e.get("wing", "wing_general")
        r = e.get("room", "general")
        c = e.get("content", "")
        s = e.get("source", "extension")
        a = e.get("agent", "localai_assistant")
        success, err = do_store(w, r, c, s, a)
        if success:
            ok_count += 1
        else:
            last_err = err
    return ok_count, last_err


# ── HTTP Handler ────────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    server_version = "MemPalaceBridge/2.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[bridge] %s — %s\n" % (self.address_string(), fmt % args))

    def _json(self, code: int, body: dict[str, Any]) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(raw.decode())

    # ── Routes ──────────────────────────────────────────────────────────────────

    def do_GET(self) -> None:
        if urlparse(self.path).path != "/health":
            self._json(404, {"ok": False, "error": "not_found"})
            return
        mp_ok = False
        try:
            import mempalace  # noqa: F401
            mp_ok = True
        except ImportError:
            pass
        self._json(200, {
            "ok": True,
            "mempalaceInstalled": mp_ok,
            "palacePath": palace_path(),
            "version": "2.0",
        })

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            body = self._body()
        except json.JSONDecodeError:
            self._json(400, {"ok": False, "error": "invalid_json"})
            return

        if path == "/search":
            q = (body.get("query") or "").strip()
            if not q:
                self._json(400, {"ok": False, "error": "missing_query"})
                return
            text, err = do_search(
                q,
                wing=body.get("wing"),
                room=body.get("room"),
                limit=min(int(body.get("limit") or 8), 25),
            )
            if err:
                self._json(503, {"ok": False, "error": err, "results": ""})
                return
            self._json(200, {"ok": True, "results": text or ""})
            return

        if path == "/store":
            w = body.get("wing", "wing_general")
            r = body.get("room", "general")
            c = body.get("content", "")
            s = body.get("source", "extension")
            a = body.get("agent", "localai_assistant")
            ok, err = do_store(w, r, c, s, a)
            self._json(200 if ok else 500, {"ok": ok, "error": err})
            return

        if path == "/store-batch":
            entries = body.get("entries")
            if not isinstance(entries, list):
                self._json(400, {"ok": False, "error": "entries_must_be_array"})
                return
            count, err = do_store_batch(entries)
            self._json(200, {"ok": True, "stored": count, "error": err})
            return

        self._json(404, {"ok": False, "error": "not_found"})


def main() -> None:
    _ensure_palace()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.socket.setsockopt(__import__("socket").SOL_SOCKET, __import__("socket").SO_REUSEADDR, 1)
    print(f"MemPalace bridge v2 on http://{HOST}:{PORT}", file=sys.stderr)
    print(f"Palace: {palace_path()}", file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nBridge stopped.", file=sys.stderr)


if __name__ == "__main__":
    main()
