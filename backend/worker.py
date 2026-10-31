"""Claude worker pool.

One worker task per PDF that has queued questions; at most POOL_SIZE run at
once. Each worker keeps a single Claude Code session per PDF (resumed across
restarts via the session id stored in comments.json), so Claude reads the
document once and sees every earlier thread on it.

Questions are durable before they reach this module: the API writes them to
comments.json with status "queued" and ACKs. The worker answers queued
messages oldest-first and waits for connectivity while offline.
"""

from __future__ import annotations

import asyncio
import logging
import time
import os
from pathlib import Path
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    CLINotFoundError,
    RateLimitEvent,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    StreamEvent,
)

from events import Bus
from providers import LOGIN_HINTS, CodexTurn, Providers, classify_codex_error
from store import Store, find_message, find_thread

log = logging.getLogger("worker")

POOL_SIZE = int(os.environ.get("PDF_ANALYZER_WORKERS", "3"))
MODEL = os.environ.get("PDF_ANALYZER_MODEL") or None
_probe = os.environ.get("PDF_ANALYZER_PROBE", "api.anthropic.com:443").rsplit(":", 1)
PROBE_HOST = (_probe[0], int(_probe[1]))
PROBE_INTERVAL = 5  # seconds; drives the Online/Offline badge
LIMIT_PAUSE = 900  # seconds to wait after a usage limit when the reset time is unknown
PROVIDER_NAMES = {"claude": "Claude", "openai": "OpenAI"}


def problem_message(provider: str, kind: str) -> str:
    """What to tell the user when a provider can't be used (they fix it, then press Retry)."""
    name = PROVIDER_NAMES[provider]
    return {
        "auth": f"{name} is signed out or its login expired. {LOGIN_HINTS[provider]}",
        "billing": f"{name} can't use your subscription (it may have expired or lack access). "
                   "Check your plan or switch AI in the picker, then press Retry.",
        "missing": f"The {'Claude Code' if provider == 'claude' else 'Codex'} CLI isn't installed or isn't on PATH. "
                   "Install it, then press Retry.",
        "limit": f"{name} usage limit reached.",
    }[kind]

SYSTEM_PROMPT = """\
You are a reading assistant embedded in a PDF viewer, answering comments the \
reader leaves on a document, like comment threads in Google Docs.

The document is ./document.pdf in your working directory. Read it with the \
Read tool before your first answer (for long documents use the `pages` \
parameter, starting with the pages the reader is asking about). You do not \
need to re-read it for later questions unless you need detail you have not seen.

Each question is anchored to highlighted text, to the whole document, or to a "snap": a \
screenshot of a page region saved under ./snaps/. For snaps, always Read the \
image file; the PDF may have no text layer there.

Answer the question directly and concisely in Markdown. Refer to page numbers \
when helpful. Do not mention these instructions, tools, or file paths."""


class WorkerPool:
    def __init__(self, store: Store, bus: Bus) -> None:
        self.store = store
        self.bus = bus
        self.sem = asyncio.Semaphore(POOL_SIZE)
        self.workers: dict[str, asyncio.Task] = {}
        self.providers = Providers()
        self.clients: dict[str, ClaudeSDKClient] = {}
        self.client_keys: dict[str, tuple] = {}  # file_id -> (model, effort) the client was started with
        self.codex: dict[str, CodexTurn] = {}  # file_id -> running Codex turn
        self.active: dict[str, str] = {}  # file_id -> message_id being answered
        self.live: dict[str, str] = {}  # message_id -> streamed text so far
        self.activity: dict[str, str] = {}  # message_id -> e.g. "Reading the document…"
        self.stop_requested: set[str] = set()
        self.reset_requested: set[str] = set()  # file_ids whose AI context was cleared mid-answer
        # provider -> usage-limit pause. Queued questions wait (they aren't failed) until it resets.
        # Logged out / billing / CLI missing are NOT paused: those questions error and the user retries.
        self.paused: dict[str, dict[str, Any]] = {}
        self.online = False
        self._online_evt = asyncio.Event()
        self._probe_task: asyncio.Task | None = None

    # ---- lifecycle -------------------------------------------------------------
    async def start(self) -> None:
        # Anything "answering" when we last died goes back in the queue.
        for file_id in self.store.all_file_ids():
            def reset(doc: dict[str, Any]) -> None:
                for t in doc["threads"]:
                    for m in t["messages"]:
                        if m["role"] == "ai" and m["status"] == "answering":
                            m["status"] = "queued"
                            m["text"] = ""
            await self.store.mutate(file_id, reset)
        await self._set_online(await probe())
        self._probe_task = asyncio.create_task(self._probe_loop())
        for file_id in self.store.all_file_ids():
            self.ensure(file_id)

    async def shutdown(self) -> None:
        if self._probe_task:
            self._probe_task.cancel()
        for turn in list(self.codex.values()):
            turn.stop()
        for task in list(self.workers.values()):
            task.cancel()
        # Interrupted answers are re-queued on next start; don't let a slow CLI hold up exit.
        await asyncio.wait([*self.workers.values()], timeout=2) if self.workers else None
        for file_id in list(self.clients):
            try:
                await asyncio.wait_for(self._drop_client(file_id), timeout=2)
            except (asyncio.TimeoutError, Exception):
                pass

    def status(self) -> dict[str, Any]:
        return {"online": self.online, "paused": self.paused, "provider": self.store.settings()["provider"]}

    def broadcast_status(self) -> None:
        self.bus.broadcast("status", self.status())

    # ---- paused providers ------------------------------------------------------------
    def pause_for_limit(self, provider: str, until: float | None = None) -> None:
        self.paused[provider] = {
            "kind": "limit", "message": problem_message(provider, "limit"),
            "until": until or time.time() + LIMIT_PAUSE,
        }
        log.warning("pausing %s until %s (usage limit)", provider, self.paused[provider]["until"])
        self.broadcast_status()

    def unpause(self, provider: str) -> None:
        if self.paused.pop(provider, None) is not None:
            log.info("resuming %s", provider)
            self.broadcast_status()
            for file_id in self.store.all_file_ids():
                self.ensure(file_id)

    def is_paused(self, provider: str) -> bool:
        p = self.paused.get(provider)
        if p and time.time() >= p["until"]:
            self.unpause(provider)  # backoff elapsed: try again
            return False
        return p is not None

    # ---- connectivity --------------------------------------------------------------
    async def _set_online(self, online: bool) -> None:
        if online == self.online:
            return
        self.online = online
        if online:
            self._online_evt.set()
        else:
            self._online_evt.clear()
        log.info("claude reachable: %s", online)
        self.bus.broadcast("status", self.status())

    async def _probe_loop(self) -> None:
        while True:
            await asyncio.sleep(PROBE_INTERVAL)
            await self._set_online(await probe())
            for provider in list(self.paused):
                self.is_paused(provider)  # lifts usage-limit pauses whose reset time has passed

    async def _wait_ready(self) -> None:
        """Wait until we're online and the currently selected provider isn't paused."""
        while not (self.online and not self.is_paused(self.store.settings()["provider"])):
            await asyncio.sleep(1)

    # ---- scheduling ------------------------------------------------------------------
    def ensure(self, file_id: str) -> None:
        task = self.workers.get(file_id)
        if task and not task.done():
            return
        if self._next_job(file_id) is None:
            return
        self.workers[file_id] = asyncio.create_task(self._run(file_id))

    def _next_job(self, file_id: str) -> tuple[str, str] | None:
        try:
            doc = self.store.read(file_id)
        except KeyError:
            return None
        queued = [
            (m["created_at"], t["id"], m["id"])
            for t in doc["threads"]
            for m in t["messages"]
            if m["role"] == "ai" and m["status"] == "queued"
        ]
        if not queued:
            return None
        _, thread_id, message_id = min(queued)
        return thread_id, message_id

    async def _run(self, file_id: str) -> None:
        try:
            async with self.sem:
                try:
                    while (job := self._next_job(file_id)) is not None:
                        await self._wait_ready()
                        if self._next_job(file_id) != job:
                            continue  # stopped/deleted while we waited
                        ok = await self._answer(file_id, *job)
                        if not ok:
                            await self._drop_client(file_id)
                finally:
                    await self._drop_client(file_id)
        except Exception:
            log.exception("worker for %s crashed", file_id)
        finally:
            self.workers.pop(file_id, None)
        # A question may have arrived while we were shutting down.
        if self._next_job(file_id) is not None:
            self.ensure(file_id)

    async def _client(self, file_id: str, agent: dict[str, Any]) -> ClaudeSDKClient:
        key = (agent.get("model"), agent.get("effort"))
        if file_id in self.clients and self.client_keys.get(file_id) != key:
            await self._drop_client(file_id)  # model/effort changed; resume the same session
        if file_id in self.clients:
            return self.clients[file_id]
        doc = self.store.read(file_id)
        workdir = self.store.dir(file_id).resolve()

        async def can_use_tool(tool: str, args: dict[str, Any], _ctx: Any):
            # Only allow reading files inside this PDF's own directory.
            if tool == "Read":
                target = (workdir / args.get("file_path", "")).resolve()
                if target.is_relative_to(workdir):
                    return PermissionResultAllow()
            return PermissionResultDeny(message="Only files in the working directory may be read.")

        env = {"ANTHROPIC_API_KEY": "", "ANTHROPIC_AUTH_TOKEN": ""}  # use subscription login
        options = ClaudeAgentOptions(
            cwd=str(workdir),
            tools=["Read"],
            can_use_tool=can_use_tool,
            system_prompt=SYSTEM_PROMPT,
            resume=doc.get("session_id"),
            include_partial_messages=True,
            # Reading a PDF returns it (base64) in one message; the 1 MB default is far too small.
            max_buffer_size=256 * 1024 * 1024,
            setting_sources=[],
            model=agent.get("model") or MODEL,
            effort=agent.get("effort"),
            env=env,
        )
        client = ClaudeSDKClient(options)
        await client.connect()
        self.clients[file_id] = client
        self.client_keys[file_id] = key
        return client

    async def _drop_client(self, file_id: str) -> None:
        self.client_keys.pop(file_id, None)
        client = self.clients.pop(file_id, None)
        if client:
            try:
                await client.disconnect()
            except Exception:
                pass

    # ---- answering one question ----------------------------------------------------------
    async def _answer(self, file_id: str, thread_id: str, message_id: str) -> bool:
        """Returns False when the failure was a connectivity problem (job re-queued)."""
        doc = self.store.read(file_id)
        thread = find_thread(doc, thread_id)
        # The AI selected *now* answers (so switching the picker also redirects queued questions).
        agent = self.store.settings()
        provider = agent["provider"]

        # Not logged in: tell the user; they log in and press Retry (no automatic retries).
        login = await self.providers.login(provider, refresh=True)
        if not login["logged_in"]:
            kind = "missing" if "not installed" in login["detail"] else "auth"
            await self._update_message(file_id, thread_id, message_id, status="error", text="", agent=agent,
                                       error=problem_message(provider, kind))
            return True

        await self._update_message(file_id, thread_id, message_id, status="answering", text="", error=None,
                                   agent=agent)
        self.active[file_id] = message_id
        self.live[message_id] = ""
        try:
            if provider == "openai":
                ok, text, error, session, block = await self._run_codex(file_id, doc, thread, message_id, agent)
                session_key = "codex_session_id"
            else:
                ok, text, error, session, block = await self._run_claude(file_id, thread, message_id, agent)
                session_key = "session_id"
        finally:
            self.active.pop(file_id, None)
            self.live.pop(message_id, None)
            self.activity.pop(message_id, None)
            self.codex.pop(file_id, None)

        if file_id in self.reset_requested:
            # Context was cleared while this answer ran: don't resurrect the old session.
            self.reset_requested.discard(file_id)
            await self._drop_client(file_id)
        elif session:
            await self.store.mutate(file_id, lambda d: d.update({session_key: session}))

        if message_id in self.stop_requested:
            self.stop_requested.discard(message_id)
            await self._update_message(file_id, thread_id, message_id, status="stopped", text=text)
            return True

        if ok:
            await self._update_message(file_id, thread_id, message_id, status="done", text=text)
            return True

        if block and block["kind"] == "limit":
            # Usage limit: keep the question queued and resume automatically when the limit resets.
            self.pause_for_limit(provider, block.get("until"))
            await self._update_message(file_id, thread_id, message_id, status="queued", text="")
            return False
        if block:
            # Logged out / subscription problem / CLI missing: error; the user fixes it and retries.
            await self._update_message(file_id, thread_id, message_id, status="error", text="",
                                       error=problem_message(provider, block["kind"]))
            return False

        # Failed. Offline -> silently re-queue; otherwise surface the error with a retry button.
        online = await probe()
        await self._set_online(online)
        if not online:
            await self._update_message(file_id, thread_id, message_id, status="queued", text="")
            return False
        if doc.get(session_key) and not session:
            # Possibly a stale/missing session; start fresh next time.
            await self.store.mutate(file_id, lambda d: d.update({session_key: None}))
        await self._update_message(file_id, thread_id, message_id, status="error", text=text, error=error)
        return False

    async def _publish_activity(self, file_id: str, thread_id: str, message_id: str, label: str) -> None:
        self.live[message_id] = ""
        self.activity[message_id] = label
        self.bus.publish(file_id, "reset", {"thread_id": thread_id, "message_id": message_id, "activity": label})

    async def _run_claude(self, file_id: str, thread: dict[str, Any], message_id: str, agent: dict[str, Any]):
        thread_id = thread["id"]
        text = ""
        result: ResultMessage | None = None
        error: str | None = None
        kind: str | None = None  # auth | billing | limit | missing
        resets_at: float | None = None
        try:
            client = await self._client(file_id, agent)
            await client.query(build_prompt(thread, message_id))
            async for msg in client.receive_response():
                if isinstance(msg, StreamEvent) and msg.parent_tool_use_id is None:
                    ev = msg.event
                    if ev.get("type") == "content_block_delta" and ev["delta"].get("type") == "text_delta":
                        chunk = ev["delta"]["text"]
                        text += chunk
                        self.live[message_id] = text
                        self.bus.publish(file_id, "delta", {"thread_id": thread_id, "message_id": message_id, "text": chunk})
                    elif ev.get("type") == "content_block_start" and ev["content_block"].get("type") == "tool_use":
                        # Text before a tool call is preamble ("Let me read..."), not the answer.
                        text = ""
                        await self._publish_activity(file_id, thread_id, message_id,
                                                     activity_label(ev["content_block"].get("name")))
                elif isinstance(msg, AssistantMessage) and msg.error:
                    error = str(msg.error)
                    kind = {"authentication_failed": "auth", "billing_error": "billing",
                            "rate_limit": "limit"}.get(msg.error, kind)
                elif isinstance(msg, RateLimitEvent) and msg.rate_limit_info.status == "rejected":
                    kind = "limit"
                    resets_at = msg.rate_limit_info.resets_at
                elif isinstance(msg, ResultMessage):
                    result = msg
        except CLINotFoundError as e:
            error, kind = str(e), "missing"
        except Exception as e:  # CLI crashed, network dropped, bad resume, ...
            log.warning("claude call failed for %s: %s", file_id, e)
            error = str(e) or type(e).__name__
            await self._drop_client(file_id)

        session = result.session_id if result else None
        if result and not result.is_error and not kind:
            return True, result.result or text, None, session, None
        if result and result.is_error and not error:
            error = "; ".join(result.errors or []) or result.result or result.subtype
        if kind:
            await self._drop_client(file_id)  # pick up fresh credentials after re-login
            return False, "", error, session, {"kind": kind, "until": resets_at}
        return False, text, error, session, None

    async def _run_codex(self, file_id: str, doc: dict[str, Any], thread: dict[str, Any], message_id: str,
                         agent: dict[str, Any]):
        thread_id = thread["id"]
        turn = CodexTurn()
        self.codex[file_id] = turn
        images = [thread["anchor"]["image"]] if thread["anchor"].get("image") else []
        await self._publish_activity(file_id, thread_id, message_id, "Thinking…")
        try:
            r = await turn.run(self.store.dir(file_id).resolve(), doc.get("codex_session_id"), agent,
                               build_prompt(thread, message_id, image_attached=bool(images)), images,
                               lambda label: self._publish_activity(file_id, thread_id, message_id, label))
        except FileNotFoundError as e:
            return False, "", str(e), None, {"kind": "missing"}
        except Exception as e:
            log.warning("codex call failed for %s: %s", file_id, e)
            return False, "", str(e) or type(e).__name__, None, None
        kind = classify_codex_error(r["error"]) if r["error"] else None
        return r["error"] is None, r["text"], r["error"], r["session_id"], {"kind": kind} if kind else None

    async def _update_message(self, file_id: str, thread_id: str, message_id: str, **fields: Any) -> None:
        def apply(doc: dict[str, Any]) -> dict[str, Any] | None:
            try:
                thread = find_thread(doc, thread_id)
                find_message(thread, message_id).update(fields)
            except KeyError:
                return None  # thread deleted mid-answer
            return thread

        try:
            thread = await self.store.mutate(file_id, apply)
        except KeyError:
            return  # file deleted
        if thread:
            self.bus.publish(file_id, "thread", thread)

    # ---- controls ----------------------------------------------------------------------
    async def stop(self, file_id: str, thread_id: str, message_id: str) -> None:
        if self.active.get(file_id) == message_id:
            self.stop_requested.add(message_id)
            if file_id in self.codex:
                self.codex[file_id].stop()
            elif client := self.clients.get(file_id):
                await client.interrupt()
            return
        await self._update_message(file_id, thread_id, message_id, status="stopped")

    async def reset_context(self, file_id: str) -> None:
        """Forget the AI conversation for this PDF; the next question starts a fresh session."""
        await self.store.mutate(file_id, lambda d: d.update(session_id=None, codex_session_id=None))
        if file_id in self.active:
            self.reset_requested.add(file_id)
        else:
            await self._drop_client(file_id)

    def overlay_live(self, doc: dict[str, Any]) -> dict[str, Any]:
        """Patch in text that is mid-stream (not persisted until the answer completes)."""
        for t in doc["threads"]:
            for m in t["messages"]:
                if m["id"] in self.live:
                    m["text"] = self.live[m["id"]]
                    m["activity"] = self.activity.get(m["id"])
        return doc


def activity_label(tool: str | None) -> str:
    return "Reading the document…" if tool == "Read" else "Working…"


def build_prompt(thread: dict[str, Any], message_id: str, image_attached: bool = False) -> str:
    anchor = thread["anchor"]
    page = anchor["page"]
    if anchor["type"] == "doc":
        lines = [f"[Comment thread {thread['id']}, whole document]",
                 "The reader is asking about the document as a whole, not a specific passage."]
    elif anchor["type"] == "page":
        lines = [f"[Comment thread {thread['id']}, page {page}]",
                 f"The reader is asking about page {page} as a whole."]
        if anchor.get("image"):
            lines.append("A picture of the whole page is attached." if image_attached else
                         f"A picture of the whole page is at ./{anchor['image']} — read it (useful if the page "
                         "has figures or no text layer).")
    elif anchor["type"] == "text":
        quote = anchor["quote"].strip().replace("\n", "\n> ")
        lines = [f"[Comment thread {thread['id']}, page {page}]",
                 f"The reader highlighted this text on page {page}:\n> {quote}"]
    else:
        lines = [f"[Comment thread {thread['id']}, page {page}]"]
        lines.append(
            f"The reader snapped a region of page {page}. The image is attached." if image_attached else
            f"The reader snapped a region of page {page}. The image is at ./{anchor['image']} "
            "— read it to see what they are asking about."
        )

    # Earlier messages in this thread (the session usually has them already, but
    # it may have been reset, so include them).
    history = []
    for m in thread["messages"]:
        if m["id"] == message_id:
            break
        history.append(m)
    question = history.pop()  # the user message this AI message answers
    if history:
        lines.append("\nEarlier in this thread:")
        for m in history:
            who = "Reader" if m["role"] == "user" else "You"
            lines.append(f"{who}: {m['text'] or '(no answer)'}")
        lines.append("\nFollow-up question:")
    else:
        lines.append("\nQuestion:")
    lines.append(question["text"])
    return "\n".join(lines)


async def probe() -> bool:
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(*PROBE_HOST), timeout=3)
        writer.close()
        return True
    except (OSError, asyncio.TimeoutError):
        return False
