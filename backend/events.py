"""In-process pub/sub that feeds the SSE endpoints."""

from __future__ import annotations

import asyncio
from typing import Any


CLOSE = object()  # sentinel: tells SSE streams to end


class Bus:
    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue]] = {}
        self.loop: asyncio.AbstractEventLoop | None = None

    def subscribe(self, channel: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subs.setdefault(channel, set()).add(q)
        return q

    def unsubscribe(self, channel: str, q: asyncio.Queue) -> None:
        self._subs.get(channel, set()).discard(q)

    def publish(self, channel: str, event: str, data: Any) -> None:
        for q in list(self._subs.get(channel, ())):
            try:
                q.put_nowait((event, data))
            except asyncio.QueueFull:
                pass  # slow client; it will resync on reconnect

    def close_all(self) -> None:
        """End every open SSE stream (safe to call from a signal handler)."""
        def close() -> None:
            for qs in self._subs.values():
                for q in qs:
                    while q.full():
                        q.get_nowait()  # drop stale events; the stream is ending anyway
                    q.put_nowait(CLOSE)
        if self.loop and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(close)

    def broadcast(self, event: str, data: Any) -> None:
        for channel in list(self._subs):
            self.publish(channel, event, data)
