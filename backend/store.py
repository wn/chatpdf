"""Durable on-disk storage.

Layout:
    data/<file_id>/document.pdf
    data/<file_id>/comments.json   # metadata + threads + Claude session id
    data/<file_id>/snaps/<thread_id>.png

comments.json is always written atomically (tmp file + fsync + rename), so a
crash can never leave a half-written file behind.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Callable

DATA_DIR = Path(os.environ.get("PDF_ANALYZER_DATA", Path(__file__).resolve().parent.parent / "data"))


def now() -> float:
    return time.time()


def new_id() -> str:
    return uuid.uuid4().hex[:12]


class Store:
    def __init__(self, root: Path = DATA_DIR):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, asyncio.Lock] = {}

    # ---- paths -------------------------------------------------------------
    def dir(self, file_id: str) -> Path:
        if not file_id.isalnum():
            raise KeyError(file_id)
        return self.root / file_id

    def pdf_path(self, file_id: str) -> Path:
        return self.dir(file_id) / "document.pdf"

    def snap_path(self, file_id: str, thread_id: str) -> Path:
        return self.dir(file_id) / "snaps" / f"{thread_id}.png"

    def _meta_path(self, file_id: str) -> Path:
        return self.dir(file_id) / "comments.json"

    def lock(self, file_id: str) -> asyncio.Lock:
        return self._locks.setdefault(file_id, asyncio.Lock())

    # ---- low level -----------------------------------------------------------
    def read(self, file_id: str) -> dict[str, Any]:
        path = self._meta_path(file_id)
        if not path.exists():
            raise KeyError(file_id)
        return json.loads(path.read_text())

    def _write(self, file_id: str, doc: dict[str, Any]) -> None:
        path = self._meta_path(file_id)
        tmp = path.with_suffix(".json.tmp")
        with open(tmp, "w") as f:
            json.dump(doc, f, indent=1)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        dir_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)

    async def mutate(self, file_id: str, fn: Callable[[dict[str, Any]], Any]) -> Any:
        """Read-modify-write comments.json under the per-file lock."""
        async with self.lock(file_id):
            doc = self.read(file_id)
            result = fn(doc)
            self._write(file_id, doc)
            return result

    # ---- files -----------------------------------------------------------------
    def list_files(self) -> list[dict[str, Any]]:
        out = []
        for d in self.root.iterdir():
            if not (d / "comments.json").exists():
                continue
            doc = self.read(d.name)
            out.append(file_summary(doc))
        return sorted(out, key=lambda f: f["created_at"], reverse=True)

    def create_file(self, name: str, data: bytes, pages: int | None = None) -> dict[str, Any]:
        file_id = new_id()
        d = self.dir(file_id)
        (d / "snaps").mkdir(parents=True)
        tmp = d / "document.pdf.tmp"
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, d / "document.pdf")
        doc = {
            "file_id": file_id,
            "name": name,
            "size": len(data),
            "pages": pages,
            "created_at": now(),
            "session_id": None,
            "threads": [],
        }
        self._write(file_id, doc)
        return doc

    def delete_file(self, file_id: str) -> None:
        shutil.rmtree(self.dir(file_id))
        self._locks.pop(file_id, None)

    async def page_count(self, file_id: str) -> int:
        """Number of pages, computed once with pymupdf and cached in comments.json."""
        pages = self.read(file_id).get("pages")
        if pages is None:
            def count() -> int:
                import pymupdf

                with pymupdf.open(self.pdf_path(file_id)) as pdf:
                    return pdf.page_count
            pages = await asyncio.to_thread(count)
            await self.mutate(file_id, lambda d: d.update(pages=pages))
        return pages

    def write_snap(self, file_id: str, thread_id: str, png: bytes) -> str:
        path = self.snap_path(file_id, thread_id)
        path.parent.mkdir(exist_ok=True)
        with open(path, "wb") as f:
            f.write(png)
            f.flush()
            os.fsync(f.fileno())
        return f"snaps/{thread_id}.png"

    # ---- global settings (which AI answers new questions) ---------------------------
    def settings(self) -> dict[str, Any]:
        from providers import default_agent

        try:
            return json.loads((self.root / "settings.json").read_text())
        except (OSError, ValueError):
            return default_agent()

    def save_settings(self, settings: dict[str, Any]) -> None:
        path = self.root / "settings.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(settings))
        os.replace(tmp, path)

    def all_file_ids(self) -> list[str]:
        return [d.name for d in self.root.iterdir() if (d / "comments.json").exists()]


def file_summary(doc: dict[str, Any]) -> dict[str, Any]:
    threads = doc["threads"]
    return {
        "file_id": doc["file_id"],
        "name": doc["name"],
        "size": doc["size"],
        "created_at": doc["created_at"],
        "thread_count": len(threads),
        "open_count": sum(1 for t in threads if not t["resolved"]),
    }


def find_thread(doc: dict[str, Any], thread_id: str) -> dict[str, Any]:
    for t in doc["threads"]:
        if t["id"] == thread_id:
            return t
    raise KeyError(thread_id)


def find_message(thread: dict[str, Any], message_id: str) -> dict[str, Any]:
    for m in thread["messages"]:
        if m["id"] == message_id:
            return m
    raise KeyError(message_id)


def user_message(text: str) -> dict[str, Any]:
    return {"id": new_id(), "role": "user", "text": text, "created_at": now()}


def ai_message(reply_to: str, agent: dict[str, Any]) -> dict[str, Any]:
    # status: queued -> answering -> done | error | stopped
    # agent: which provider/model/effort answers; fixed when the question is asked.
    return {
        "id": new_id(),
        "role": "ai",
        "reply_to": reply_to,
        "agent": agent,
        "text": "",
        "status": "queued",
        "error": None,
        "created_at": now(),
    }
