"""Fail-open relay client.

Design contract (CLAUDE.md §2.3): a down or slow relay must never stall or
crash the user's agents. send() stamps a per-agent sequence number, enqueues,
and returns — a background task owns the connection, reconnects with backoff,
and drains the queue. When the bounded queue overflows, the oldest event is
dropped and counted; the seq gap lets the UI surface "N events dropped"
instead of silently rendering a wrong graph.
"""
import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any
import websockets

logger = logging.getLogger(__name__)

MAX_BUFFERED_EVENTS = 10_000
INITIAL_BACKOFF_S = 0.2
MAX_BACKOFF_S = 5.0


class RelayClient:
    def __init__(self, host: str = "localhost", port: int = 3333):
        self._uri = f"ws://{host}:{port}/sdk"
        self._handlers: dict[str, list[Callable[[dict], Any]]] = {}
        self._queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=MAX_BUFFERED_EVENTS)
        self._pending_send: dict | None = None  # in-flight event retained across reconnects
        self._seq: dict[str, int] = {}
        self._connected = asyncio.Event()
        self._closing = False
        self._run_task: asyncio.Task | None = None
        self.events_dropped = 0

    def on_command(self, kind: str, handler: Callable[[dict], Any]) -> None:
        # Handlers are synchronous. Return value is truthy if the command was
        # actually applied (used for command_ack status).
        self._handlers.setdefault(kind, []).append(handler)

    async def connect(self, wait_timeout: float = 2.0) -> None:
        """Start the connection task. Waits briefly for the first connection
        but does NOT raise if the relay is down — emission is fail-open."""
        if self._run_task is None:
            self._run_task = asyncio.create_task(self._run())
        try:
            await asyncio.wait_for(self._connected.wait(), timeout=wait_timeout)
        except asyncio.TimeoutError:
            logger.warning("Relay not reachable at %s — buffering events", self._uri)

    async def send(self, payload: dict[str, Any]) -> None:
        """Stamp seq, enqueue, return. Never blocks on the network, never raises."""
        self._stamp_seq(payload)
        try:
            self._queue.put_nowait(payload)
        except asyncio.QueueFull:
            try:
                self._queue.get_nowait()
                self.events_dropped += 1
            except asyncio.QueueEmpty:
                pass
            try:
                self._queue.put_nowait(payload)
            except asyncio.QueueFull:
                self.events_dropped += 1

    def _stamp_seq(self, payload: dict[str, Any]) -> None:
        key = payload.get("agent_id") or payload.get("from_agent_id") or "_session"
        n = self._seq.get(key, 0)
        payload["seq"] = n
        self._seq[key] = n + 1

    async def flush(self, timeout: float = 2.0) -> None:
        """Best-effort drain of the outgoing queue."""
        deadline = asyncio.get_running_loop().time() + timeout
        while (not self._queue.empty() or self._pending_send is not None):
            if asyncio.get_running_loop().time() > deadline:
                return
            await asyncio.sleep(0.02)

    async def close(self) -> None:
        await self.flush()
        self._closing = True
        if self._run_task:
            self._run_task.cancel()
            await asyncio.gather(self._run_task, return_exceptions=True)

    # ---- connection lifecycle -------------------------------------------

    async def _run(self) -> None:
        backoff = INITIAL_BACKOFF_S
        while not self._closing:
            try:
                async with websockets.connect(self._uri) as ws:
                    self._connected.set()
                    backoff = INITIAL_BACKOFF_S
                    recv_task = asyncio.create_task(self._recv_loop(ws))
                    try:
                        await self._send_loop(ws)
                    finally:
                        recv_task.cancel()
                        await asyncio.gather(recv_task, return_exceptions=True)
            except asyncio.CancelledError:
                raise
            except Exception:
                pass  # fail-open: connection errors only delay delivery
            self._connected.clear()
            if self._closing:
                return
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, MAX_BACKOFF_S)

    async def _send_loop(self, ws) -> None:
        while True:
            if self._pending_send is None:
                self._pending_send = await self._queue.get()
            await ws.send(json.dumps(self._pending_send))
            self._pending_send = None

    async def _recv_loop(self, ws) -> None:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = msg.get("kind", "")
            applied = False
            for handler in self._handlers.get(kind, []):
                try:
                    if handler(msg):
                        applied = True
                except Exception:
                    logger.exception("Error dispatching command %s", kind)
            if "cmd_id" in msg:
                await self.send({
                    "kind": "command_ack",
                    "cmd_id": msg["cmd_id"],
                    "status": "applied" if applied else "failed",
                    "timestamp": __import__("time").time(),
                })
