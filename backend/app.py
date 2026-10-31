"""Local PDF Q&A server.

Run:  nix-shell --run ./run.sh   (serves UI + API on http://127.0.0.1:8000)
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from events import CLOSE, Bus
from providers import validate_agent
from store import Store, ai_message, file_summary, find_message, find_thread, new_id, now, user_message
from worker import WorkerPool

# Never let a stray API key in the environment switch billing away from the subscription.
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

store = Store()
bus = Bus()
pool = WorkerPool(store, bus)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    bus.loop = asyncio.get_running_loop()
    await pool.start()
    yield
    await pool.shutdown()


app = FastAPI(lifespan=lifespan)


def get_doc(file_id: str) -> dict[str, Any]:
    try:
        return store.read(file_id)
    except KeyError:
        raise HTTPException(404, "file not found")


async def mutate(file_id: str, fn):
    try:
        return await store.mutate(file_id, fn)
    except KeyError:
        raise HTTPException(404, "not found")


# ---- files ---------------------------------------------------------------------------
@app.get("/api/files")
def list_files():
    return store.list_files()


@app.put("/api/files", status_code=201)
async def upload_file(file: UploadFile):
    data = await file.read()
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, "not a PDF")
    pages = await asyncio.to_thread(count_pages, data)
    if not pages:
        raise HTTPException(400, "this PDF is damaged, unreadable, or password-protected")
    doc = store.create_file(file.filename or "document.pdf", data, pages)
    return file_summary(doc)


def count_pages(data: bytes) -> int:
    """Page count, or 0 if the PDF can't be opened (damaged, or encrypted with a password)."""
    import pymupdf

    try:
        with pymupdf.open(stream=data, filetype="pdf") as pdf:
            return 0 if pdf.needs_pass else pdf.page_count
    except Exception:
        return 0


@app.get("/api/files/{file_id}")
def get_file(file_id: str):
    get_doc(file_id)
    return FileResponse(store.pdf_path(file_id), media_type="application/pdf")


@app.delete("/api/files/{file_id}", status_code=204)
async def delete_file(file_id: str):
    get_doc(file_id)
    task = pool.workers.get(file_id)
    if task:
        task.cancel()
    store.delete_file(file_id)


@app.get("/api/files/{file_id}/snaps/{thread_id}.png")
def get_snap(file_id: str, thread_id: str):
    get_doc(file_id)
    path = store.snap_path(file_id, thread_id)
    if not thread_id.isalnum() or not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="image/png")


# ---- comments ----------------------------------------------------------------------------
class Rect(BaseModel):
    # Fractions of page width/height (0..1), so anchors survive zoom changes.
    x: float
    y: float
    w: float
    h: float


class Anchor(BaseModel):
    type: Literal["text", "snap", "page", "doc"]  # page = a whole page; doc = the whole document
    page: int = Field(default=1, ge=1)
    rects: list[Rect] = []  # text: one rect per line of the selection; snap: the region; doc: empty
    quote: str = ""


class NewThread(BaseModel):
    anchor: Anchor
    text: str = Field(min_length=1)
    snap_png: str | None = None  # base64 PNG (data URL ok) for snap anchors


class Reply(BaseModel):
    text: str = Field(min_length=1)


class ThreadPatch(BaseModel):
    resolved: bool


@app.get("/api/files/{file_id}/comments")
def get_comments(file_id: str):
    doc = pool.overlay_live(get_doc(file_id))
    return {"threads": doc["threads"], "status": pool.status()}


@app.post("/api/files/{file_id}/comments", status_code=202)
async def create_thread(file_id: str, body: NewThread):
    get_doc(file_id)
    thread_id = new_id()
    anchor = body.anchor.model_dump()
    if anchor["type"] != "doc" and anchor["page"] > await store.page_count(file_id):
        raise HTTPException(400, "page is past the end of the document")
    if anchor["type"] == "snap" and not body.snap_png:
        raise HTTPException(400, "snap_png required for snap anchors")
    if anchor["type"] in ("snap", "page") and body.snap_png:
        try:
            png = base64.b64decode(body.snap_png.split(",", 1)[-1], validate=True)
        except ValueError:
            raise HTTPException(400, "snap_png is not valid base64")
        if not png.startswith(b"\x89PNG"):
            raise HTTPException(400, "snap_png must be a PNG image")
        anchor["image"] = store.write_snap(file_id, thread_id, png)
    question = user_message(body.text)
    thread = {
        "id": thread_id,
        "anchor": anchor,
        "resolved": False,
        "created_at": now(),
        "messages": [question, ai_message(question["id"], store.settings())],
    }
    await mutate(file_id, lambda d: d["threads"].append(thread))
    bus.publish(file_id, "thread", thread)
    pool.ensure(file_id)
    return thread


@app.post("/api/files/{file_id}/comments/{thread_id}/replies", status_code=202)
async def reply(file_id: str, thread_id: str, body: Reply):
    def apply(doc):
        thread = find_thread(doc, thread_id)
        q = user_message(body.text)
        thread["messages"] += [q, ai_message(q["id"], store.settings())]
        thread["resolved"] = False
        return thread

    thread = await mutate(file_id, apply)
    bus.publish(file_id, "thread", thread)
    pool.ensure(file_id)
    return thread


@app.patch("/api/files/{file_id}/comments/{thread_id}")
async def patch_thread(file_id: str, thread_id: str, body: ThreadPatch):
    def apply(doc):
        thread = find_thread(doc, thread_id)
        thread["resolved"] = body.resolved
        return thread

    thread = await mutate(file_id, apply)
    bus.publish(file_id, "thread", thread)
    return thread


@app.delete("/api/files/{file_id}/comments/{thread_id}", status_code=204)
async def delete_thread(file_id: str, thread_id: str):
    doc = get_doc(file_id)
    try:
        thread = find_thread(doc, thread_id)
    except KeyError:
        raise HTTPException(404)
    for m in thread["messages"]:
        if m["role"] == "ai" and m["status"] in ("queued", "answering"):
            await pool.stop(file_id, thread_id, m["id"])
    await mutate(file_id, lambda d: d.update(threads=[t for t in d["threads"] if t["id"] != thread_id]))
    store.snap_path(file_id, thread_id).unlink(missing_ok=True)
    bus.publish(file_id, "thread_deleted", {"thread_id": thread_id})


@app.post("/api/files/{file_id}/reset-context")
async def reset_context(file_id: str):
    """Clear context: resolve open whole-document conversations and reset the AI sessions."""
    def apply(doc):
        closed = [t for t in doc["threads"] if t["anchor"]["type"] == "doc" and not t["resolved"]]
        for t in closed:
            t["resolved"] = True
        return closed

    for t in await mutate(file_id, apply):
        bus.publish(file_id, "thread", t)
    await pool.reset_context(file_id)
    return {"ok": True}


@app.post("/api/files/{file_id}/comments/{thread_id}/messages/{message_id}/stop", status_code=202)
async def stop_message(file_id: str, thread_id: str, message_id: str):
    doc = get_doc(file_id)
    try:
        msg = find_message(find_thread(doc, thread_id), message_id)
    except KeyError:
        raise HTTPException(404)
    if msg["role"] == "ai" and msg["status"] in ("queued", "answering"):
        await pool.stop(file_id, thread_id, message_id)
    return {"ok": True}


@app.post("/api/files/{file_id}/comments/{thread_id}/messages/{message_id}/retry", status_code=202)
async def retry_message(file_id: str, thread_id: str, message_id: str):
    def apply(doc):
        thread = find_thread(doc, thread_id)
        msg = find_message(thread, message_id)
        if msg["role"] != "ai" or msg["status"] not in ("error", "stopped"):
            raise HTTPException(409, "message is not retryable")
        # Retry with whichever AI is currently selected (e.g. after switching away from one that failed).
        msg.update(status="queued", text="", error=None, created_at=now(), agent=store.settings())
        return thread

    thread = await mutate(file_id, apply)
    bus.publish(file_id, "thread", thread)
    pool.ensure(file_id)
    return thread


# ---- SSE -------------------------------------------------------------------------------------
@app.get("/api/files/{file_id}/events")
async def events(file_id: str, request: Request):
    get_doc(file_id)
    q = bus.subscribe(file_id)

    async def stream():
        try:
            yield sse("status", pool.status())
            while not await request.is_disconnected():
                try:
                    item = await asyncio.wait_for(q.get(), timeout=15)
                    if item is CLOSE:
                        return  # server shutting down
                    yield sse(*item)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            bus.unsubscribe(file_id, q)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


class Settings(BaseModel):
    provider: Literal["claude", "openai"]
    model: str | None = None
    effort: str | None = None


@app.get("/api/agents")
async def agents(refresh: bool = False):
    """Providers with login status, models and efforts, plus the current selection."""
    return {"providers": await pool.providers.catalog(refresh), "settings": store.settings(), "paused": pool.paused}


@app.post("/api/providers/{provider}/resume")
def resume_provider(provider: Literal["claude", "openai"]):
    """'Try again now': lift a pause early (e.g. right after logging in or upgrading the plan)."""
    pool.unpause(provider)
    return pool.status()


@app.put("/api/settings")
def put_settings(body: Settings):
    settings = validate_agent(body.model_dump())
    store.save_settings(settings)
    pool.broadcast_status()  # the toolbar badge shows the selected provider's state
    return settings


@app.get("/api/status")
def status():
    return pool.status()


# ---- UI ----------------------------------------------------------------------------------------
DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"


@app.middleware("http")
async def no_cache_index(request: Request, call_next):
    # Built assets are content-hashed; index.html must never be cached so rebuilds show up.
    response = await call_next(request)
    if not request.url.path.startswith(("/api", "/assets")):
        response.headers["Cache-Control"] = "no-cache"
    return response


if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="ui")
