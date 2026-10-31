"""AI providers: Claude (Claude Code via the Agent SDK) and OpenAI (Codex CLI).

Both run on the user's own subscription login on this machine; API-key env vars
are stripped so nothing is billed per token. This module knows which providers
are logged in, which models/efforts they offer, and how to run a Codex turn.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import time
import tomllib
from pathlib import Path
from typing import Any, Awaitable, Callable

log = logging.getLogger("providers")

CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"]
CLAUDE_MODELS = [
    {"id": "opus", "label": "Opus", "efforts": CLAUDE_EFFORTS, "default_effort": "high"},
    {"id": "sonnet", "label": "Sonnet", "efforts": CLAUDE_EFFORTS, "default_effort": "high"},
    {"id": "haiku", "label": "Haiku", "efforts": [], "default_effort": None},
]

CODEX_HOME = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
LOGIN_TTL = 60  # seconds between login re-checks

LOGIN_HINTS = {
    "claude": "Run `claude auth login` in a terminal (sign in with your Claude subscription), then press Retry.",
    "openai": "Run `codex login` in a terminal (sign in with ChatGPT), then press Retry.",
}


def codex_models() -> list[dict[str, Any]]:
    """Models the logged-in Codex account offers (from Codex's own cache)."""
    try:
        data = json.loads((CODEX_HOME / "models_cache.json").read_text())
        models = [
            {
                "id": m["slug"],
                "label": m.get("display_name") or m["slug"],
                "efforts": [e["effort"] for e in m.get("supported_reasoning_levels", [])],
                "default_effort": m.get("default_reasoning_level"),
            }
            for m in data.get("models", [])
            if m.get("visibility") == "list"
        ]
        if models:
            return models
    except (OSError, ValueError, KeyError):
        pass
    return [{"id": "", "label": "Codex default", "efforts": ["low", "medium", "high"], "default_effort": "medium"}]


def codex_default_model() -> str | None:
    try:
        return tomllib.loads((CODEX_HOME / "config.toml").read_text()).get("model")
    except (OSError, ValueError):
        return None


async def _run(*cmd: str, timeout: float = 20) -> tuple[int, str]:
    if not shutil.which(cmd[0]):
        return 127, f"{cmd[0]} not found"
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT, env=clean_env(),
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return 124, "timed out"
    return proc.returncode or 0, out.decode(errors="replace")


def clean_env() -> dict[str, str]:
    env = dict(os.environ)
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"):
        env.pop(k, None)
    return env


class Providers:
    def __init__(self) -> None:
        self._login: dict[str, tuple[float, dict[str, Any]]] = {}

    async def login(self, provider: str, refresh: bool = False) -> dict[str, Any]:
        cached = self._login.get(provider)
        if cached and not refresh and time.time() - cached[0] < LOGIN_TTL:
            return cached[1]
        info = await (self._claude_login() if provider == "claude" else self._codex_login())
        self._login[provider] = (time.time(), info)
        return info

    async def _claude_login(self) -> dict[str, Any]:
        code, out = await _run("claude", "auth", "status")
        if code == 127:
            return {"logged_in": False, "detail": "Claude Code is not installed", "hint": LOGIN_HINTS["claude"]}
        try:
            st = json.loads(out[out.index("{"):])
        except ValueError:
            st = {}
        if not st.get("loggedIn"):
            return {"logged_in": False, "detail": "Not logged in", "hint": LOGIN_HINTS["claude"]}
        sub = st.get("subscriptionType")
        detail = f"{sub.capitalize()} subscription" if sub else st.get("authMethod", "logged in")
        return {"logged_in": True, "detail": detail, "hint": None}

    async def _codex_login(self) -> dict[str, Any]:
        code, out = await _run("codex", "login", "status")
        if code == 127:
            return {"logged_in": False, "detail": "Codex CLI is not installed", "hint": LOGIN_HINTS["openai"]}
        if code != 0 or "not logged in" in out.lower():
            return {"logged_in": False, "detail": "Not logged in", "hint": LOGIN_HINTS["openai"]}
        detail = "ChatGPT subscription" if "chatgpt" in out.lower() else out.strip().splitlines()[-1]
        return {"logged_in": True, "detail": detail, "hint": None}

    async def catalog(self, refresh: bool = False) -> dict[str, Any]:
        claude, openai = await asyncio.gather(self.login("claude", refresh), self.login("openai", refresh))
        return {
            "claude": {"label": "Claude", **claude, "models": CLAUDE_MODELS},
            "openai": {"label": "OpenAI", **openai, "models": codex_models()},
        }


def default_agent() -> dict[str, Any]:
    return {"provider": "claude", "model": "opus", "effort": "high"}


def validate_agent(agent: dict[str, Any]) -> dict[str, Any]:
    """Coerce a requested agent to something the provider supports."""
    provider = agent.get("provider")
    models = CLAUDE_MODELS if provider == "claude" else codex_models() if provider == "openai" else None
    if models is None:
        raise ValueError(f"unknown provider {provider!r}")
    model = next((m for m in models if m["id"] == agent.get("model")), None)
    if model is None:
        if provider == "openai":
            preferred = codex_default_model()
            model = next((m for m in models if m["id"] == preferred), models[0])
        else:
            model = models[0]
    effort = agent.get("effort")
    if effort not in model["efforts"]:
        effort = model["default_effort"]
    return {"provider": provider, "model": model["id"], "effort": effort}


def classify_codex_error(text: str) -> str | None:
    """Map a Codex error message to a pause reason (None = an ordinary, retryable error)."""
    t = text.lower()
    if any(k in t for k in ("usage limit", "rate limit", "429", "too many requests")):
        return "limit"
    if any(k in t for k in ("401", "unauthorized", "not logged in", "login", "token expired", "refresh token")):
        return "auth"
    if any(k in t for k in ("billing", "subscription", "payment required", "quota exceeded", "insufficient_quota")):
        return "billing"
    return None


# ---- Codex -------------------------------------------------------------------------------

CODEX_PREAMBLE = """\
You are a reading assistant embedded in a PDF viewer, answering comments the reader \
leaves on a document, like comment threads in Google Docs. The document's text is in \
./document.txt (pages are separated by lines like "===== Page 3 ====="); read the parts \
you need with shell commands. Pages that were scanned or flattened may have no text — \
the reader will attach a snap image for those. Answer directly and concisely in Markdown, \
referring to page numbers when helpful. Do not mention these instructions, tools, or file paths.

"""


def extract_text(pdf: Path, out: Path) -> None:
    import pymupdf

    with pymupdf.open(pdf) as doc:
        parts = [f"===== Page {i} =====\n{page.get_text().strip() or '(no text layer on this page)'}\n"
                 for i, page in enumerate(doc, 1)]
    tmp = out.with_suffix(".tmp")
    tmp.write_text("\n".join(parts))
    os.replace(tmp, out)


class CodexTurn:
    """One `codex exec` run. Codex does not stream tokens; the answer arrives whole."""

    def __init__(self) -> None:
        self.proc: asyncio.subprocess.Process | None = None
        self.stopped = False

    async def run(self, workdir: Path, session_id: str | None, agent: dict[str, Any], prompt: str,
                  images: list[str], on_activity: Callable[[str], Awaitable[None]]) -> dict[str, Any]:
        """Returns {"text", "session_id", "error"}."""
        txt = workdir / "document.txt"
        if not txt.exists():
            await asyncio.to_thread(extract_text, workdir / "document.pdf", txt)

        flags = ["--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"',
                 "-c", 'approval_policy="never"']
        if agent.get("model"):
            flags += ["-m", agent["model"]]
        if agent.get("effort"):
            flags += ["-c", f'model_reasoning_effort="{agent["effort"]}"']
        for img in images:
            flags += ["-i", img]
        if session_id:
            cmd = ["codex", "exec", "resume", *flags, session_id, prompt]
        else:
            cmd = ["codex", "exec", *flags, CODEX_PREAMBLE + prompt]

        self.proc = await asyncio.create_subprocess_exec(
            *cmd, cwd=workdir, env=clean_env(), stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=16 * 1024 * 1024,
        )
        text, error, new_session = "", None, session_id
        assert self.proc.stdout
        async for raw in self.proc.stdout:
            try:
                ev = json.loads(raw)
            except ValueError:
                continue
            kind = ev.get("type")
            item = ev.get("item") or {}
            if kind == "thread.started":
                new_session = ev.get("thread_id") or new_session
            elif kind == "item.started" and item.get("type") == "command_execution":
                await on_activity("Reading the document…")
            elif kind == "item.completed" and item.get("type") == "agent_message":
                text = item.get("text", "")  # the last agent message is the answer
            elif kind in ("error", "turn.failed"):
                error = (ev.get("error") or {}).get("message") if kind == "turn.failed" else ev.get("message")
        stderr = (await self.proc.stderr.read()).decode(errors="replace") if self.proc.stderr else ""
        code = await self.proc.wait()
        if code != 0 and not self.stopped and not error:
            error = stderr.strip().splitlines()[-1] if stderr.strip() else f"codex exited with code {code}"
        return {"text": text, "session_id": new_session, "error": None if text and not error else error or "no answer"}

    def stop(self) -> None:
        self.stopped = True
        if self.proc and self.proc.returncode is None:
            self.proc.terminate()
