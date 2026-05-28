import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any
import websockets

logger = logging.getLogger(__name__)


class RelayClient:
    def __init__(self, host: str = "localhost", port: int = 3333):
        self._uri = f"ws://{host}:{port}/sdk"
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._handlers: dict[str, list[Callable[[dict], None]]] = {}
        self._listener_task: asyncio.Task | None = None

    def on_command(self, kind: str, handler: Callable[[dict], None]) -> None:
        # handlers must be synchronous; async handlers will not be awaited
        self._handlers.setdefault(kind, []).append(handler)

    async def connect(self) -> None:
        self._ws = await websockets.connect(self._uri)
        self._listener_task = asyncio.create_task(self._listen())

    async def send(self, payload: dict[str, Any]) -> None:
        if self._ws is None:
            raise RuntimeError("RelayClient not connected")
        await self._ws.send(json.dumps(payload))

    async def close(self) -> None:
        if self._listener_task:
            self._listener_task.cancel()
            await asyncio.gather(self._listener_task, return_exceptions=True)
        if self._ws:
            await self._ws.close()

    async def _listen(self) -> None:
        try:
            async for raw in self._ws:  # type: ignore[union-attr]
                try:
                    msg = json.loads(raw)
                    kind = msg.get("kind", "")
                    for handler in self._handlers.get(kind, []):
                        handler(msg)
                except Exception:
                    logger.exception("Error dispatching command")
        except websockets.ConnectionClosed:
            pass
