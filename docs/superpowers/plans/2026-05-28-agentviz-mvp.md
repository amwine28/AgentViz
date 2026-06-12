# AgentViz MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the AgentViz v1 MVP — a Python SDK that instruments agents and streams events to a local relay server, with a React browser UI that visualizes the live agent graph, message threads, and tool call approvals.

**Architecture:** Python SDK emits events over WebSocket to a Node.js relay server (localhost:3333). The relay fans events to all connected browsers and routes UI control commands back to the correct agent. The browser UI renders a 2D force-directed graph of agents, with node detail panels and clickable message edges.

**Tech Stack:** Python 3.11+ / asyncio / websockets, Node.js 20+ / ws / TypeScript, React 18 / Vite / d3-force

---

## Task 1: Repo setup + shared event schema

**Files:**
- Create: `sdk/agentviz/events.py`
- Create: `sdk/agentviz/exceptions.py`
- Create: `sdk/pyproject.toml`
- Create: `ui/src/types.ts`

This task defines the contract everything else builds on. Every event type and command type is defined here once.

- [ ] **Step 1: Create SDK package scaffold**

```bash
cd ~/Desktop/AgentViz
mkdir -p sdk/agentviz sdk/tests relay/src relay/tests ui/src/components ui/tests
touch sdk/agentviz/__init__.py
```

- [ ] **Step 2: Write `sdk/pyproject.toml`**

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.backends.legacy:build"

[project]
name = "agentviz"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["websockets>=12.0"]

[tool.setuptools.packages.find]
where = ["."]
include = ["agentviz*"]
```

- [ ] **Step 3: Write `sdk/agentviz/exceptions.py`**

```python
class ToolCallDenied(Exception):
    def __init__(self, call_id: str, tool_name: str):
        self.call_id = call_id
        self.tool_name = tool_name
        super().__init__(f"Tool call '{tool_name}' (id={call_id}) was denied by the user")

class AgentStopped(Exception):
    def __init__(self, agent_id: str):
        self.agent_id = agent_id
        super().__init__(f"Agent '{agent_id}' was stopped by the user")
```

- [ ] **Step 4: Write `sdk/agentviz/events.py`**

```python
from dataclasses import dataclass, field, asdict
from typing import Any, Literal
import time
import uuid

EventKind = Literal[
    "agent_spawn", "agent_status", "tool_call_pending",
    "tool_result", "agent_message", "log", "agent_complete"
]
CommandKind = Literal[
    "tool_approve", "tool_deny", "agent_pause", "agent_resume",
    "agent_stop", "inject_message", "spawn_agent"
]
AgentStatus = Literal["running", "waiting", "complete", "error", "paused"]


def _now() -> float:
    return time.time()

def _id() -> str:
    return str(uuid.uuid4())


@dataclass
class AgentSpawnEvent:
    kind: EventKind = field(default="agent_spawn", init=False)
    agent_id: str = field(default_factory=_id)
    parent_id: str | None = None
    name: str = ""
    timestamp: float = field(default_factory=_now)

@dataclass
class AgentStatusEvent:
    kind: EventKind = field(default="agent_status", init=False)
    agent_id: str = ""
    status: AgentStatus = "running"
    timestamp: float = field(default_factory=_now)

@dataclass
class ToolCallPendingEvent:
    kind: EventKind = field(default="tool_call_pending", init=False)
    agent_id: str = ""
    call_id: str = field(default_factory=_id)
    name: str = ""
    args: dict[str, Any] = field(default_factory=dict)
    timestamp: float = field(default_factory=_now)

@dataclass
class ToolResultEvent:
    kind: EventKind = field(default="tool_result", init=False)
    agent_id: str = ""
    call_id: str = ""
    result: Any = None
    duration_ms: int = 0
    timestamp: float = field(default_factory=_now)

@dataclass
class AgentMessageEvent:
    kind: EventKind = field(default="agent_message", init=False)
    from_agent_id: str = ""
    to_agent_id: str = ""
    content: str = ""
    timestamp: float = field(default_factory=_now)

@dataclass
class LogEvent:
    kind: EventKind = field(default="log", init=False)
    agent_id: str = ""
    content: str = ""
    level: Literal["info", "warn", "error"] = "info"
    timestamp: float = field(default_factory=_now)

@dataclass
class AgentCompleteEvent:
    kind: EventKind = field(default="agent_complete", init=False)
    agent_id: str = ""
    exit_status: Literal["ok", "error", "stopped"] = "ok"
    summary: str = ""
    timestamp: float = field(default_factory=_now)


def serialize(event: object) -> dict:
    return asdict(event)  # type: ignore[arg-type]
```

- [ ] **Step 5: Write `ui/src/types.ts`** (mirrors the Python event shapes)

```typescript
export type AgentStatus = "running" | "waiting" | "complete" | "error" | "paused";
export type EventKind =
  | "agent_spawn" | "agent_status" | "tool_call_pending"
  | "tool_result" | "agent_message" | "log" | "agent_complete";
export type CommandKind =
  | "tool_approve" | "tool_deny" | "agent_pause" | "agent_resume"
  | "agent_stop" | "inject_message" | "spawn_agent";

export interface AgentSpawnEvent {
  kind: "agent_spawn";
  agent_id: string;
  parent_id: string | null;
  name: string;
  timestamp: number;
}
export interface AgentStatusEvent {
  kind: "agent_status";
  agent_id: string;
  status: AgentStatus;
  timestamp: number;
}
export interface ToolCallPendingEvent {
  kind: "tool_call_pending";
  agent_id: string;
  call_id: string;
  name: string;
  args: Record<string, unknown>;
  timestamp: number;
}
export interface ToolResultEvent {
  kind: "tool_result";
  agent_id: string;
  call_id: string;
  result: unknown;
  duration_ms: number;
  timestamp: number;
}
export interface AgentMessageEvent {
  kind: "agent_message";
  from_agent_id: string;
  to_agent_id: string;
  content: string;
  timestamp: number;
}
export interface LogEvent {
  kind: "log";
  agent_id: string;
  content: string;
  level: "info" | "warn" | "error";
  timestamp: number;
}
export interface AgentCompleteEvent {
  kind: "agent_complete";
  agent_id: string;
  exit_status: "ok" | "error" | "stopped";
  summary: string;
  timestamp: number;
}

export type AgentVizEvent =
  | AgentSpawnEvent | AgentStatusEvent | ToolCallPendingEvent
  | ToolResultEvent | AgentMessageEvent | LogEvent | AgentCompleteEvent;

// UI state shapes
export interface AgentNode {
  id: string;
  name: string;
  parent_id: string | null;
  status: AgentStatus;
  tool_calls: Array<{ call_id: string; name: string; args: Record<string, unknown>; result?: unknown; duration_ms?: number; pending: boolean }>;
  logs: Array<{ content: string; level: string; timestamp: number }>;
}

export interface MessageEdge {
  from_agent_id: string;
  to_agent_id: string;
  messages: Array<{ content: string; timestamp: number; from: string; to: string }>;
}
```

- [ ] **Step 6: Install SDK in dev mode**

```bash
cd ~/Desktop/AgentViz/sdk
pip install -e ".[dev]" 2>/dev/null || pip install -e .
```

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/AgentViz
git init
git add sdk/ ui/src/types.ts
git commit -m "feat: repo scaffold + shared event schema"
```

---

## Task 2: SDK relay client

**Files:**
- Create: `sdk/agentviz/relay_client.py`
- Create: `sdk/tests/test_relay_client.py`

The relay client handles the WebSocket connection from SDK to relay — sending events and dispatching incoming commands to registered handlers.

- [ ] **Step 1: Write the failing test**

```python
# sdk/tests/test_relay_client.py
import asyncio
import json
import pytest
import websockets
from agentviz.relay_client import RelayClient
from agentviz.events import AgentSpawnEvent, serialize

@pytest.mark.asyncio
async def test_relay_client_sends_event(unused_tcp_port):
    received = []

    async def fake_relay(ws):
        msg = await ws.recv()
        received.append(json.loads(msg))

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        client = RelayClient(port=unused_tcp_port)
        await client.connect()
        event = AgentSpawnEvent(agent_id="a1", name="test-agent")
        await client.send(serialize(event))
        await asyncio.sleep(0.05)

    assert len(received) == 1
    assert received[0]["kind"] == "agent_spawn"
    assert received[0]["agent_id"] == "a1"

@pytest.mark.asyncio
async def test_relay_client_dispatches_command(unused_tcp_port):
    received_command = {}

    async def fake_relay(ws):
        await ws.send(json.dumps({"kind": "tool_approve", "call_id": "c1"}))
        await asyncio.sleep(0.1)

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        client = RelayClient(port=unused_tcp_port)
        client.on_command("tool_approve", lambda cmd: received_command.update(cmd))
        await client.connect()
        await asyncio.sleep(0.1)

    assert received_command.get("call_id") == "c1"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Desktop/AgentViz/sdk
pip install pytest pytest-asyncio websockets
pytest tests/test_relay_client.py -v
```

Expected: `ImportError: cannot import name 'RelayClient'`

- [ ] **Step 3: Write `sdk/agentviz/relay_client.py`**

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Desktop/AgentViz/sdk
pytest tests/test_relay_client.py -v
```

Expected: `2 passed`

- [ ] **Step 5: Commit**

```bash
git add sdk/agentviz/relay_client.py sdk/tests/test_relay_client.py
git commit -m "feat: SDK relay client with send + command dispatch"
```

---

## Task 3: SDK Session + Agent context manager

**Files:**
- Create: `sdk/agentviz/session.py`
- Create: `sdk/agentviz/agent.py`
- Modify: `sdk/agentviz/__init__.py`
- Create: `sdk/tests/test_session.py`

- [ ] **Step 1: Write the failing tests**

```python
# sdk/tests/test_session.py
import asyncio
import json
import pytest
import websockets
from agentviz import session

@pytest.mark.asyncio
async def test_session_emits_agent_spawn_and_complete(unused_tcp_port):
    events = []

    async def fake_relay(ws, path="/"):
        async for msg in ws:
            events.append(json.loads(msg))

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        s = session(name="test-run", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("orchestrator") as agent:
            assert agent.agent_id is not None
        await asyncio.sleep(0.05)
        await s.close()

    kinds = [e["kind"] for e in events]
    assert "agent_spawn" in kinds
    assert "agent_complete" in kinds

@pytest.mark.asyncio
async def test_agent_emits_status_changes(unused_tcp_port):
    events = []

    async def fake_relay(ws, path="/"):
        async for msg in ws:
            events.append(json.loads(msg))

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        s = session(name="test-run", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("worker") as agent:
            await agent.set_status("waiting")
        await asyncio.sleep(0.05)
        await s.close()

    status_events = [e for e in events if e["kind"] == "agent_status"]
    statuses = [e["status"] for e in status_events]
    assert "running" in statuses
    assert "waiting" in statuses
    assert "complete" in statuses

@pytest.mark.asyncio
async def test_child_agent_has_parent_id(unused_tcp_port):
    events = []

    async def fake_relay(ws, path="/"):
        async for msg in ws:
            events.append(json.loads(msg))

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        s = session(name="test-run", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("parent") as parent:
            async with s.agent("child", parent_id=parent.agent_id):
                pass
        await asyncio.sleep(0.05)
        await s.close()

    spawns = [e for e in events if e["kind"] == "agent_spawn"]
    child_spawn = next(e for e in spawns if e["name"] == "child")
    parent_spawn = next(e for e in spawns if e["name"] == "parent")
    assert child_spawn["parent_id"] == parent_spawn["agent_id"]
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Desktop/AgentViz/sdk
pytest tests/test_session.py -v
```

Expected: `ImportError: cannot import name 'session' from 'agentviz'`

- [ ] **Step 3: Write `sdk/agentviz/agent.py`**

```python
import asyncio
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING
from .events import (
    AgentSpawnEvent, AgentStatusEvent, AgentCompleteEvent,
    AgentStatus, serialize, _id
)
from .exceptions import AgentStopped

if TYPE_CHECKING:
    from .relay_client import RelayClient


class Agent:
    def __init__(self, name: str, relay: "RelayClient", parent_id: str | None = None):
        self.agent_id: str = _id()
        self.name = name
        self._relay = relay
        self._parent_id = parent_id
        self._paused = asyncio.Event()
        self._paused.set()  # not paused by default
        self._stopped = False
        self._pending_tool_calls: dict[str, asyncio.Future] = {}

        relay.on_command("agent_pause", self._on_pause)
        relay.on_command("agent_resume", self._on_resume)
        relay.on_command("agent_stop", self._on_stop)
        self.injected_messages: asyncio.Queue[str] = asyncio.Queue()
        relay.on_command("inject_message", self._on_inject)

    async def set_status(self, status: AgentStatus) -> None:
        await self._relay.send(serialize(
            AgentStatusEvent(agent_id=self.agent_id, status=status)
        ))

    def is_paused(self) -> bool:
        return not self._paused.is_set()

    async def wait_if_paused(self) -> None:
        await self._paused.wait()
        if self._stopped:
            raise AgentStopped(self.agent_id)

    def _on_pause(self, cmd: dict) -> None:
        if cmd.get("agent_id") in (self.agent_id, None):
            self._paused.clear()

    def _on_resume(self, cmd: dict) -> None:
        if cmd.get("agent_id") in (self.agent_id, None):
            self._paused.set()

    def _on_stop(self, cmd: dict) -> None:
        if cmd.get("agent_id") in (self.agent_id, None):
            self._stopped = True
            self._paused.set()

    def _on_inject(self, cmd: dict) -> None:
        if cmd.get("agent_id") in (self.agent_id, None):
            self.injected_messages.put_nowait(cmd.get("content", ""))

    def register_pending_tool_call(self, call_id: str, future: asyncio.Future) -> None:
        self._pending_tool_calls[call_id] = future

    def resolve_tool_call(self, call_id: str, approved: bool) -> None:
        fut = self._pending_tool_calls.pop(call_id, None)
        if fut and not fut.done():
            if approved:
                fut.set_result(True)
            else:
                fut.set_exception(Exception(f"denied:{call_id}"))

    async def _emit_spawn(self) -> None:
        await self._relay.send(serialize(
            AgentSpawnEvent(agent_id=self.agent_id, parent_id=self._parent_id, name=self.name)
        ))
        await self.set_status("running")

    async def _emit_complete(self, exit_status: str = "ok", summary: str = "") -> None:
        await self.set_status("complete")
        await self._relay.send(serialize(
            AgentCompleteEvent(agent_id=self.agent_id, exit_status=exit_status, summary=summary)
        ))
```

- [ ] **Step 4: Write `sdk/agentviz/session.py`**

```python
import asyncio
import subprocess
import socket
import time
from contextlib import asynccontextmanager
from .relay_client import RelayClient
from .agent import Agent
from .events import AgentMessageEvent, LogEvent, serialize


def _relay_is_running(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("localhost", port)) == 0


class Session:
    def __init__(self, name: str, port: int = 3333, autostart_relay: bool = True):
        self.name = name
        self._port = port
        self._autostart = autostart_relay
        self._relay_proc: subprocess.Popen | None = None
        self._client = RelayClient(port=port)

    async def connect(self) -> None:
        if self._autostart and not _relay_is_running(self._port):
            relay_dir = str(__import__("pathlib").Path(__file__).parent.parent.parent / "relay")
            self._relay_proc = subprocess.Popen(
                ["node", "dist/index.js"],
                cwd=relay_dir,
            )
            # wait up to 3s for relay to start
            for _ in range(30):
                if _relay_is_running(self._port):
                    break
                time.sleep(0.1)

        self._client.on_command("tool_approve", self._dispatch_tool_approval)
        self._client.on_command("tool_deny", self._dispatch_tool_denial)
        await self._client.connect()
        self._agents: dict[str, Agent] = {}

    async def close(self) -> None:
        await self._client.close()
        if self._relay_proc:
            self._relay_proc.terminate()

    @asynccontextmanager
    async def agent(self, name: str, parent_id: str | None = None):
        a = Agent(name=name, relay=self._client, parent_id=parent_id)
        self._agents[a.agent_id] = a
        await a._emit_spawn()
        try:
            yield a
            await a._emit_complete(exit_status="ok")
        except Exception as exc:
            await a._emit_complete(exit_status="error", summary=str(exc))
            raise
        finally:
            self._agents.pop(a.agent_id, None)

    async def send_message(self, from_agent: str, to_agent: str, content: str) -> None:
        # Resolve names to IDs if needed
        from_id = self._name_to_id(from_agent) or from_agent
        to_id = self._name_to_id(to_agent) or to_agent
        await self._client.send(serialize(
            AgentMessageEvent(from_agent_id=from_id, to_agent_id=to_id, content=content)
        ))

    def _name_to_id(self, name_or_id: str) -> str | None:
        for agent in self._agents.values():
            if agent.name == name_or_id or agent.agent_id == name_or_id:
                return agent.agent_id
        return None

    def _dispatch_tool_approval(self, cmd: dict) -> None:
        agent = self._agents.get(cmd.get("agent_id", ""))
        if agent:
            agent.resolve_tool_call(cmd["call_id"], approved=True)

    def _dispatch_tool_denial(self, cmd: dict) -> None:
        agent = self._agents.get(cmd.get("agent_id", ""))
        if agent:
            agent.resolve_tool_call(cmd["call_id"], approved=False)


def session(name: str, port: int = 3333, autostart_relay: bool = True) -> Session:
    return Session(name=name, port=port, autostart_relay=autostart_relay)
```

- [ ] **Step 5: Write `sdk/agentviz/__init__.py`**

```python
from .session import session, Session
from .exceptions import ToolCallDenied, AgentStopped

__all__ = ["session", "Session", "ToolCallDenied", "AgentStopped"]
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd ~/Desktop/AgentViz/sdk
pytest tests/test_session.py -v
```

Expected: `3 passed`

- [ ] **Step 7: Commit**

```bash
git add sdk/agentviz/session.py sdk/agentviz/agent.py sdk/agentviz/__init__.py sdk/tests/test_session.py
git commit -m "feat: SDK Session and Agent context manager"
```

---

## Task 4: SDK tool call approval

**Files:**
- Create: `sdk/tests/test_tool_call.py`
- Modify: `sdk/agentviz/agent.py` — add `tool_call()` method

- [ ] **Step 1: Write the failing tests**

```python
# sdk/tests/test_tool_call.py
import asyncio
import json
import pytest
import websockets
from agentviz import session, ToolCallDenied

@pytest.mark.asyncio
async def test_tool_call_approved(unused_tcp_port):
    result_holder = {}

    async def fake_relay(ws, path="/"):
        async for raw in ws:
            msg = json.loads(raw)
            if msg["kind"] == "tool_call_pending":
                await ws.send(json.dumps({
                    "kind": "tool_approve",
                    "agent_id": msg["agent_id"],
                    "call_id": msg["call_id"]
                }))

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        s = session(name="test", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("worker") as agent:
            result = await agent.tool_call(
                name="my_tool",
                args={"x": 1},
                fn=lambda: "tool_result_value",
                approval_timeout=2.0
            )
            result_holder["result"] = result
        await s.close()

    assert result_holder["result"] == "tool_result_value"

@pytest.mark.asyncio
async def test_tool_call_denied_raises(unused_tcp_port):
    async def fake_relay(ws, path="/"):
        async for raw in ws:
            msg = json.loads(raw)
            if msg["kind"] == "tool_call_pending":
                await ws.send(json.dumps({
                    "kind": "tool_deny",
                    "agent_id": msg["agent_id"],
                    "call_id": msg["call_id"]
                }))

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        s = session(name="test", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        with pytest.raises(ToolCallDenied):
            async with s.agent("worker") as agent:
                await agent.tool_call(
                    name="my_tool",
                    args={},
                    fn=lambda: "never",
                    approval_timeout=2.0
                )
        await s.close()

@pytest.mark.asyncio
async def test_tool_call_auto_approves_on_timeout(unused_tcp_port):
    result_holder = {}

    async def fake_relay(ws, path="/"):
        async for _ in ws:
            pass  # never responds

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        s = session(name="test", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("worker") as agent:
            result = await agent.tool_call(
                name="my_tool",
                args={},
                fn=lambda: "auto",
                approval_timeout=0.1  # very short timeout
            )
            result_holder["result"] = result
        await s.close()

    assert result_holder["result"] == "auto"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Desktop/AgentViz/sdk
pytest tests/test_tool_call.py -v
```

Expected: `AttributeError: 'Agent' object has no attribute 'tool_call'`

- [ ] **Step 3: Add `tool_call()` to `sdk/agentviz/agent.py`**

Add these imports at the top of `agent.py`:
```python
import time
from .events import ToolCallPendingEvent, ToolResultEvent
from .exceptions import ToolCallDenied
```

Add this method to the `Agent` class:
```python
    async def tool_call(
        self,
        name: str,
        args: dict,
        fn: callable,
        approval_timeout: float = 30.0,
    ):
        loop = asyncio.get_event_loop()
        future: asyncio.Future = loop.create_future()
        event = ToolCallPendingEvent(agent_id=self.agent_id, name=name, args=args)
        call_id = event.call_id
        self.register_pending_tool_call(call_id, future)

        await self._relay.send(serialize(event))

        try:
            await asyncio.wait_for(asyncio.shield(future), timeout=approval_timeout)
        except asyncio.TimeoutError:
            self._pending_tool_calls.pop(call_id, None)
            # auto-approve on timeout
        except Exception as exc:
            if "denied" in str(exc):
                raise ToolCallDenied(call_id=call_id, tool_name=name)
            raise

        t0 = time.monotonic()
        result = fn()
        duration_ms = int((time.monotonic() - t0) * 1000)
        await self._relay.send(serialize(
            ToolResultEvent(agent_id=self.agent_id, call_id=call_id, result=result, duration_ms=duration_ms)
        ))
        return result
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/Desktop/AgentViz/sdk
pytest tests/test_tool_call.py -v
```

Expected: `3 passed`

- [ ] **Step 5: Run all SDK tests**

```bash
pytest tests/ -v
```

Expected: all passing

- [ ] **Step 6: Commit**

```bash
git add sdk/agentviz/agent.py sdk/tests/test_tool_call.py
git commit -m "feat: SDK tool call approval with timeout auto-approve"
```

---

## Task 5: Relay server

**Files:**
- Create: `relay/package.json`
- Create: `relay/tsconfig.json`
- Create: `relay/src/buffer.ts`
- Create: `relay/src/relay.ts`
- Create: `relay/src/index.ts`
- Create: `relay/tests/relay.test.ts`

The relay is a Node.js WebSocket server. SDK clients connect to `/sdk`, browsers to `/`. Events from SDK clients are buffered and fanned out to all browser clients. Commands from browsers are routed to the correct SDK client by `agent_id`.

- [ ] **Step 1: Write `relay/package.json`**

```json
{
  "name": "agentviz-relay",
  "version": "0.1.0",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "ts-node src/index.ts",
    "test": "jest"
  },
  "dependencies": {
    "ws": "^8.16.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.10",
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0",
    "ts-node": "^10.9.2",
    "jest": "^29.0.0",
    "ts-jest": "^29.0.0",
    "@types/jest": "^29.5.0"
  }
}
```

- [ ] **Step 2: Write `relay/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Install relay dependencies**

```bash
cd ~/Desktop/AgentViz/relay
npm install
```

- [ ] **Step 4: Write the failing test**

```typescript
// relay/tests/relay.test.ts
import WebSocket from "ws";
import { createRelay } from "../src/relay";

describe("relay", () => {
  let relay: ReturnType<typeof createRelay>;
  const PORT = 13333;

  beforeEach(() => {
    relay = createRelay(PORT);
  });

  afterEach((done) => {
    relay.close(done);
  });

  test("fans SDK event out to browser client", (done) => {
    const sdkWs = new WebSocket(`ws://localhost:${PORT}/sdk`);
    const browserWs = new WebSocket(`ws://localhost:${PORT}/`);

    browserWs.on("message", (data) => {
      const events = JSON.parse(data.toString());
      const evt = Array.isArray(events) ? events[events.length - 1] : events;
      expect(evt.kind).toBe("agent_spawn");
      expect(evt.agent_id).toBe("a1");
      sdkWs.close();
      browserWs.close();
      done();
    });

    sdkWs.on("open", () => {
      sdkWs.send(JSON.stringify({ kind: "agent_spawn", agent_id: "a1", name: "test", parent_id: null, timestamp: Date.now() }));
    });
  });

  test("routes command from browser to SDK client", (done) => {
    const sdkWs = new WebSocket(`ws://localhost:${PORT}/sdk`);
    const browserWs = new WebSocket(`ws://localhost:${PORT}/`);

    sdkWs.on("message", (data) => {
      const cmd = JSON.parse(data.toString());
      expect(cmd.kind).toBe("tool_approve");
      expect(cmd.call_id).toBe("c1");
      sdkWs.close();
      browserWs.close();
      done();
    });

    browserWs.on("open", () => {
      browserWs.send(JSON.stringify({ kind: "tool_approve", agent_id: "a1", call_id: "c1" }));
    });
  });

  test("new browser client receives buffered events on connect", (done) => {
    const sdkWs = new WebSocket(`ws://localhost:${PORT}/sdk`);

    sdkWs.on("open", () => {
      sdkWs.send(JSON.stringify({ kind: "agent_spawn", agent_id: "a2", name: "buffered", parent_id: null, timestamp: Date.now() }));

      setTimeout(() => {
        const lateBrowser = new WebSocket(`ws://localhost:${PORT}/`);
        lateBrowser.on("message", (data) => {
          const events = JSON.parse(data.toString());
          expect(Array.isArray(events)).toBe(true);
          expect(events.some((e: { agent_id: string }) => e.agent_id === "a2")).toBe(true);
          lateBrowser.close();
          sdkWs.close();
          done();
        });
      }, 50);
    });
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

```bash
cd ~/Desktop/AgentViz/relay
npx ts-jest --testPathPattern=tests/relay.test.ts 2>/dev/null || npx jest tests/relay.test.ts
```

Expected: `Cannot find module '../src/relay'`

- [ ] **Step 6: Write `relay/src/buffer.ts`**

```typescript
export class SessionBuffer {
  private events: unknown[] = [];
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  push(event: unknown): void {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.shift();
    }
  }

  all(): unknown[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}
```

- [ ] **Step 7: Write `relay/src/relay.ts`**

```typescript
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { SessionBuffer } from "./buffer";

export function createRelay(port: number) {
  const buffer = new SessionBuffer();
  const sdkClients = new Set<WebSocket>();
  const browserClients = new Set<WebSocket>();

  const wss = new WebSocketServer({ port });

  function isSdkPath(req: IncomingMessage): boolean {
    return req.url === "/sdk";
  }

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    if (isSdkPath(req)) {
      sdkClients.add(ws);

      ws.on("message", (data) => {
        try {
          const event = JSON.parse(data.toString());
          buffer.push(event);
          for (const browser of browserClients) {
            if (browser.readyState === WebSocket.OPEN) {
              browser.send(JSON.stringify(event));
            }
          }
        } catch { /* ignore malformed */ }
      });

      ws.on("close", () => sdkClients.delete(ws));
    } else {
      // Browser client — send buffer catch-up immediately
      const catchUp = buffer.all();
      if (catchUp.length > 0) {
        ws.send(JSON.stringify(catchUp));
      }
      browserClients.add(ws);

      ws.on("message", (data) => {
        // Commands from browser → route to all SDK clients
        // (SDK client filters by agent_id internally)
        try {
          const cmd = JSON.parse(data.toString());
          for (const sdk of sdkClients) {
            if (sdk.readyState === WebSocket.OPEN) {
              sdk.send(JSON.stringify(cmd));
            }
          }
        } catch { /* ignore */ }
      });

      ws.on("close", () => browserClients.delete(ws));
    }
  });

  return {
    close: (cb?: () => void) => wss.close(cb),
  };
}
```

- [ ] **Step 8: Write `relay/src/index.ts`**

```typescript
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { SessionBuffer } from "./buffer";

const PORT = parseInt(process.env.AGENTVIZ_PORT ?? "3333", 10);
const UI_DIST = path.resolve(__dirname, "../../ui/dist");

const buffer = new SessionBuffer();
const sdkClients = new Set<WebSocket>();
const browserClients = new Set<WebSocket>();

// HTTP server: serves built UI static files
const server = http.createServer((req, res) => {
  const urlPath = req.url === "/" ? "/index.html" : (req.url ?? "/index.html");
  const filePath = path.join(UI_DIST, urlPath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // fallback to index.html for SPA routing
      fs.readFile(path.join(UI_DIST, "index.html"), (_e, html) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      });
    } else {
      const ext = path.extname(filePath);
      const contentType = ext === ".js" ? "application/javascript" : ext === ".css" ? "text/css" : "text/html";
      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
    }
  });
});

// WebSocket server on same port
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  if (req.url === "/sdk") {
    sdkClients.add(ws);
    ws.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString());
        buffer.push(event);
        for (const browser of browserClients) {
          if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(event));
        }
      } catch { /* ignore */ }
    });
    ws.on("close", () => sdkClients.delete(ws));
  } else {
    const catchUp = buffer.all();
    if (catchUp.length > 0) ws.send(JSON.stringify(catchUp));
    browserClients.add(ws);
    ws.on("message", (data) => {
      try {
        const cmd = JSON.parse(data.toString());
        for (const sdk of sdkClients) {
          if (sdk.readyState === WebSocket.OPEN) sdk.send(JSON.stringify(cmd));
        }
      } catch { /* ignore */ }
    });
    ws.on("close", () => browserClients.delete(ws));
  }
});

server.listen(PORT, () => {
  console.log(`AgentViz relay running on http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});
```

- [ ] **Step 9: Run tests to verify they pass**

```bash
cd ~/Desktop/AgentViz/relay
npx jest tests/relay.test.ts --forceExit
```

Expected: `3 passed`

- [ ] **Step 10: Commit**

```bash
git add relay/
git commit -m "feat: relay server with fan-out, command routing, session buffer"
```

---

## Task 6: Browser UI — project setup + store

**Files:**
- Create: `ui/package.json`
- Create: `ui/vite.config.ts`
- Create: `ui/index.html`
- Create: `ui/src/main.tsx`
- Create: `ui/src/ws.ts`
- Create: `ui/src/store.ts`
- Create: `ui/tests/store.test.ts`

- [ ] **Step 1: Write `ui/package.json`**

```json
{
  "name": "agentviz-ui",
  "version": "0.1.0",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "d3-force": "^3.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "@types/d3-force": "^3.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "typescript": "^5.0.0",
    "vite": "^5.0.0",
    "vitest": "^1.0.0"
  }
}
```

- [ ] **Step 2: Write `ui/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
  },
  server: {
    port: 5173,
  },
});
```

- [ ] **Step 3: Write `ui/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>AgentViz</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { background: #0d0d14; color: #e0e0f0; font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; overflow: hidden; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Write the failing store test**

```typescript
// ui/tests/store.test.ts
import { describe, test, expect } from "vitest";
import { reducer, initialState } from "../src/store";
import type { AgentSpawnEvent, AgentStatusEvent, ToolCallPendingEvent, AgentMessageEvent } from "../src/types";

describe("store reducer", () => {
  test("agent_spawn adds node", () => {
    const event: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "orch", timestamp: 1 };
    const state = reducer(initialState, { type: "event", event });
    expect(state.agents["a1"]).toBeDefined();
    expect(state.agents["a1"].name).toBe("orch");
    expect(state.agents["a1"].status).toBe("running");
  });

  test("agent_status updates status", () => {
    const spawn: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "orch", timestamp: 1 };
    const status: AgentStatusEvent = { kind: "agent_status", agent_id: "a1", status: "waiting", timestamp: 2 };
    let state = reducer(initialState, { type: "event", event: spawn });
    state = reducer(state, { type: "event", event: status });
    expect(state.agents["a1"].status).toBe("waiting");
  });

  test("tool_call_pending appends to agent tool_calls as pending", () => {
    const spawn: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "orch", timestamp: 1 };
    const toolCall: ToolCallPendingEvent = { kind: "tool_call_pending", agent_id: "a1", call_id: "c1", name: "my_tool", args: { x: 1 }, timestamp: 2 };
    let state = reducer(initialState, { type: "event", event: spawn });
    state = reducer(state, { type: "event", event: toolCall });
    expect(state.agents["a1"].tool_calls).toHaveLength(1);
    expect(state.agents["a1"].tool_calls[0].pending).toBe(true);
    expect(state.agents["a1"].tool_calls[0].name).toBe("my_tool");
  });

  test("agent_message creates message edge", () => {
    const msg: AgentMessageEvent = { kind: "agent_message", from_agent_id: "a1", to_agent_id: "a2", content: "hello", timestamp: 1 };
    const state = reducer(initialState, { type: "event", event: msg });
    const edgeKey = "a1:a2";
    expect(state.messageEdges[edgeKey]).toBeDefined();
    expect(state.messageEdges[edgeKey].messages).toHaveLength(1);
    expect(state.messageEdges[edgeKey].messages[0].content).toBe("hello");
  });

  test("select_node sets selectedNodeId", () => {
    const state = reducer(initialState, { type: "select_node", agent_id: "a1" });
    expect(state.selectedNodeId).toBe("a1");
  });

  test("select_edge sets selectedEdgeKey", () => {
    const state = reducer(initialState, { type: "select_edge", edge_key: "a1:a2" });
    expect(state.selectedEdgeKey).toBe("a1:a2");
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

```bash
cd ~/Desktop/AgentViz/ui
npm install
npx vitest run tests/store.test.ts
```

Expected: `Cannot find module '../src/store'`

- [ ] **Step 6: Write `ui/src/store.ts`**

```typescript
import type {
  AgentVizEvent, AgentNode, MessageEdge, AgentStatus,
  ToolCallPendingEvent, ToolResultEvent
} from "./types";

export interface AppState {
  agents: Record<string, AgentNode>;
  messageEdges: Record<string, MessageEdge>; // key: "from:to"
  selectedNodeId: string | null;
  selectedEdgeKey: string | null;
  sessionName: string;
  connected: boolean;
}

export const initialState: AppState = {
  agents: {},
  messageEdges: {},
  selectedNodeId: null,
  selectedEdgeKey: null,
  sessionName: "",
  connected: false,
};

type Action =
  | { type: "event"; event: AgentVizEvent }
  | { type: "select_node"; agent_id: string | null }
  | { type: "select_edge"; edge_key: string | null }
  | { type: "connected"; value: boolean }
  | { type: "batch_events"; events: AgentVizEvent[] };

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "batch_events":
      return action.events.reduce(
        (s, event) => reducer(s, { type: "event", event }),
        state
      );
    case "event":
      return applyEvent(state, action.event);
    case "select_node":
      return { ...state, selectedNodeId: action.agent_id, selectedEdgeKey: null };
    case "select_edge":
      return { ...state, selectedEdgeKey: action.edge_key, selectedNodeId: null };
    case "connected":
      return { ...state, connected: action.value };
    default:
      return state;
  }
}

function applyEvent(state: AppState, event: AgentVizEvent): AppState {
  switch (event.kind) {
    case "agent_spawn": {
      const node: AgentNode = {
        id: event.agent_id,
        name: event.name,
        parent_id: event.parent_id,
        status: "running",
        tool_calls: [],
        logs: [],
      };
      return { ...state, agents: { ...state.agents, [event.agent_id]: node } };
    }
    case "agent_status": {
      const agent = state.agents[event.agent_id];
      if (!agent) return state;
      return {
        ...state,
        agents: { ...state.agents, [event.agent_id]: { ...agent, status: event.status as AgentStatus } },
      };
    }
    case "tool_call_pending": {
      const agent = state.agents[event.agent_id];
      if (!agent) return state;
      const tc = { call_id: event.call_id, name: event.name, args: event.args, pending: true };
      return {
        ...state,
        agents: { ...state.agents, [event.agent_id]: { ...agent, tool_calls: [...agent.tool_calls, tc] } },
      };
    }
    case "tool_result": {
      const agent = state.agents[event.agent_id];
      if (!agent) return state;
      const updated = agent.tool_calls.map((tc) =>
        tc.call_id === event.call_id
          ? { ...tc, pending: false, result: event.result, duration_ms: event.duration_ms }
          : tc
      );
      return { ...state, agents: { ...state.agents, [event.agent_id]: { ...agent, tool_calls: updated } } };
    }
    case "agent_message": {
      const key = `${event.from_agent_id}:${event.to_agent_id}`;
      const existing = state.messageEdges[key] ?? {
        from_agent_id: event.from_agent_id,
        to_agent_id: event.to_agent_id,
        messages: [],
      };
      const msg = { content: event.content, timestamp: event.timestamp, from: event.from_agent_id, to: event.to_agent_id };
      const updated: MessageEdge = { ...existing, messages: [...existing.messages, msg] };
      return { ...state, messageEdges: { ...state.messageEdges, [key]: updated } };
    }
    case "log": {
      const agent = state.agents[event.agent_id];
      if (!agent) return state;
      const log = { content: event.content, level: event.level, timestamp: event.timestamp };
      return { ...state, agents: { ...state.agents, [event.agent_id]: { ...agent, logs: [...agent.logs, log] } } };
    }
    case "agent_complete": {
      const agent = state.agents[event.agent_id];
      if (!agent) return state;
      const status: AgentStatus = event.exit_status === "ok" ? "complete" : event.exit_status === "stopped" ? "paused" : "error";
      return { ...state, agents: { ...state.agents, [event.agent_id]: { ...agent, status } } };
    }
    default:
      return state;
  }
}
```

- [ ] **Step 7: Write `ui/src/ws.ts`**

```typescript
import type { AgentVizEvent } from "./types";

type Dispatch = (action: { type: string; [key: string]: unknown }) => void;

export function createWsConnection(port: number, dispatch: Dispatch): () => void {
  const ws = new WebSocket(`ws://localhost:${port}`);

  ws.onopen = () => dispatch({ type: "connected", value: true });
  ws.onclose = () => dispatch({ type: "connected", value: false });

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (Array.isArray(data)) {
        dispatch({ type: "batch_events", events: data as AgentVizEvent[] });
      } else {
        dispatch({ type: "event", event: data as AgentVizEvent });
      }
    } catch { /* ignore */ }
  };

  function sendCommand(cmd: object): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(cmd));
    }
  }

  (window as Window & { agentVizSend?: typeof sendCommand }).agentVizSend = sendCommand;

  return () => ws.close();
}
```

- [ ] **Step 8: Run store tests to verify they pass**

```bash
cd ~/Desktop/AgentViz/ui
npx vitest run tests/store.test.ts
```

Expected: `6 passed`

- [ ] **Step 9: Commit**

```bash
git add ui/
git commit -m "feat: UI project setup, store reducer, WebSocket connection"
```

---

## Task 7: Browser UI — Graph component

**Files:**
- Create: `ui/src/components/Graph.tsx`
- Create: `ui/src/App.tsx`
- Create: `ui/src/main.tsx`

- [ ] **Step 1: Write `ui/src/components/Graph.tsx`**

```tsx
import { useEffect, useRef } from "react";
import * as d3 from "d3-force";
import type { AgentNode, MessageEdge } from "../types";

interface Props {
  agents: Record<string, AgentNode>;
  messageEdges: Record<string, MessageEdge>;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onSelectEdge: (key: string) => void;
  onCommand: (cmd: object) => void;
}

const STATUS_COLORS: Record<string, string> = {
  running: "#60a5fa",
  waiting: "#f59e0b",
  complete: "#34d399",
  error: "#f87171",
  paused: "#f59e0b",
};
const ROOT_COLOR = "#a78bfa";

interface SimNode { id: string; x: number; y: number; fx?: number | null; fy?: number | null }
interface SimLink { source: string; target: string; type: "spawn" | "message" }

export function Graph({ agents, messageEdges, selectedNodeId, onSelectNode, onSelectEdge }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const W = svg.clientWidth || 800;
    const H = svg.clientHeight || 600;

    const nodes: SimNode[] = Object.values(agents).map((a) => ({ id: a.id, x: W / 2, y: H / 2 }));
    const spawnLinks: SimLink[] = Object.values(agents)
      .filter((a) => a.parent_id)
      .map((a) => ({ source: a.parent_id!, target: a.id, type: "spawn" }));
    const msgLinks: SimLink[] = Object.keys(messageEdges).map((key) => {
      const [from, to] = key.split(":");
      return { source: from, target: to, type: "message" };
    });
    const links = [...spawnLinks, ...msgLinks];

    if (simRef.current) simRef.current.stop();

    const sim = d3.forceSimulation<SimNode>(nodes)
      .force("link", d3.forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(120))
      .force("charge", d3.forceManyBody().strength(-300))
      .force("center", d3.forceCenter(W / 2, H / 2));

    simRef.current = sim;

    const el = svg as unknown as SVGSVGElement;
    // Clear previous render
    while (el.firstChild) el.removeChild(el.firstChild);

    // Defs
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = `
      <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
        <path d="M0,0 L0,6 L6,3 z" fill="#2d2d4e"/>
      </marker>
      <marker id="arrow-msg" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
        <path d="M0,0 L0,6 L6,3 z" fill="#a78bfa"/>
      </marker>
      <style>
        @keyframes dash { to { stroke-dashoffset: -16; } }
        .msg-edge { animation: dash 0.9s linear infinite; }
      </style>
    `;
    el.appendChild(defs);

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    el.appendChild(g);

    // Render edges
    const edgeEls: SVGLineElement[] = links.map((link) => {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      if (link.type === "spawn") {
        line.setAttribute("stroke", "#2d2d4e");
        line.setAttribute("stroke-width", "1.5");
        line.setAttribute("marker-end", "url(#arrow)");
      } else {
        line.setAttribute("stroke", "#a78bfa");
        line.setAttribute("stroke-width", "1.5");
        line.setAttribute("stroke-dasharray", "5 4");
        line.setAttribute("marker-end", "url(#arrow-msg)");
        line.setAttribute("class", "msg-edge");
        line.style.cursor = "pointer";
        const key = `${(link.source as unknown as SimNode).id ?? link.source}:${(link.target as unknown as SimNode).id ?? link.target}`;
        line.addEventListener("click", () => onSelectEdge(key));
      }
      g.appendChild(line);
      return line;
    });

    // Render nodes
    const nodeEls = nodes.map((node) => {
      const agent = agents[node.id];
      const isRoot = !agent.parent_id;
      const color = isRoot ? ROOT_COLOR : STATUS_COLORS[agent.status] ?? "#888";
      const r = isRoot ? 20 : 14;

      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("r", String(r));
      circle.setAttribute("fill", "#1a1a2e");
      circle.setAttribute("stroke", color);
      circle.setAttribute("stroke-width", selectedNodeId === node.id ? "3" : "1.5");
      circle.style.cursor = "pointer";
      circle.addEventListener("click", () => onSelectNode(node.id));
      g.appendChild(circle);

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("dy", String(r + 14));
      label.setAttribute("fill", "#aaa");
      label.setAttribute("font-size", "10");
      label.setAttribute("pointer-events", "none");
      label.textContent = agent.name;
      g.appendChild(label);

      return { circle, label, node };
    });

    sim.on("tick", () => {
      nodes.forEach((node, i) => {
        nodeEls[i].circle.setAttribute("cx", String(node.x));
        nodeEls[i].circle.setAttribute("cy", String(node.y));
        nodeEls[i].label.setAttribute("x", String(node.x));
        nodeEls[i].label.setAttribute("y", String(node.y));
      });
      links.forEach((link, i) => {
        const s = link.source as unknown as SimNode;
        const t = link.target as unknown as SimNode;
        if (s.x != null) {
          edgeEls[i].setAttribute("x1", String(s.x));
          edgeEls[i].setAttribute("y1", String(s.y));
          edgeEls[i].setAttribute("x2", String(t.x));
          edgeEls[i].setAttribute("y2", String(t.y));
        }
      });
    });

    return () => sim.stop();
  }, [agents, messageEdges, selectedNodeId]);

  return (
    <svg
      ref={svgRef}
      style={{ width: "100%", height: "100%", background: "#0d0d14" }}
    />
  );
}
```

- [ ] **Step 2: Write `ui/src/App.tsx`**

```tsx
import { useReducer, useEffect, useCallback } from "react";
import { reducer, initialState } from "./store";
import { createWsConnection } from "./ws";
import { Graph } from "./components/Graph";
import { NodeDetailPanel } from "./components/NodeDetailPanel";
import { MessageThread } from "./components/MessageThread";
import { TopBar } from "./components/TopBar";

const RELAY_PORT = 3333;

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    return createWsConnection(RELAY_PORT, dispatch as (a: object) => void);
  }, []);

  const sendCommand = useCallback((cmd: object) => {
    (window as Window & { agentVizSend?: (cmd: object) => void }).agentVizSend?.(cmd);
  }, []);

  const runningCount = Object.values(state.agents).filter((a) => a.status === "running").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <TopBar
        connected={state.connected}
        runningCount={runningCount}
        onPauseAll={() => sendCommand({ kind: "agent_pause", agent_id: null })}
        onStopAll={() => sendCommand({ kind: "agent_stop", agent_id: null })}
      />
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, position: "relative" }}>
          <Graph
            agents={state.agents}
            messageEdges={state.messageEdges}
            selectedNodeId={state.selectedNodeId}
            onSelectNode={(id) => dispatch({ type: "select_node", agent_id: id })}
            onSelectEdge={(key) => dispatch({ type: "select_edge", edge_key: key })}
            onCommand={sendCommand}
          />
        </div>
        {state.selectedNodeId && (
          <NodeDetailPanel
            agent={state.agents[state.selectedNodeId]}
            onClose={() => dispatch({ type: "select_node", agent_id: null })}
            onCommand={sendCommand}
          />
        )}
        {state.selectedEdgeKey && state.messageEdges[state.selectedEdgeKey] && (
          <MessageThread
            edge={state.messageEdges[state.selectedEdgeKey]}
            agents={state.agents}
            onClose={() => dispatch({ type: "select_edge", edge_key: null })}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write `ui/src/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/Graph.tsx ui/src/App.tsx ui/src/main.tsx
git commit -m "feat: UI graph canvas with D3 force layout and edge types"
```

---

## Task 8: Browser UI — side panels

**Files:**
- Create: `ui/src/components/NodeDetailPanel.tsx`
- Create: `ui/src/components/MessageThread.tsx`
- Create: `ui/src/components/TopBar.tsx`

- [ ] **Step 1: Write `ui/src/components/TopBar.tsx`**

```tsx
interface Props {
  connected: boolean;
  runningCount: number;
  onPauseAll: () => void;
  onStopAll: () => void;
}

export function TopBar({ connected, runningCount, onPauseAll, onStopAll }: Props) {
  return (
    <div style={{
      height: 40, background: "#111120", borderBottom: "1px solid #1e1e30",
      display: "flex", alignItems: "center", padding: "0 16px", gap: 16
    }}>
      <span style={{ color: "#a78bfa", fontWeight: 700, fontSize: 13 }}>⬡ AgentViz</span>
      <span style={{ color: "#555", fontSize: 11 }}>
        <span style={{
          display: "inline-block", width: 7, height: 7, borderRadius: "50%",
          background: connected ? "#34d399" : "#555",
          boxShadow: connected ? "0 0 6px #34d39988" : "none",
          marginRight: 6
        }} />
        {connected ? `${runningCount} agent${runningCount !== 1 ? "s" : ""} running` : "disconnected"}
      </span>
      <div style={{ flex: 1 }} />
      <button onClick={onPauseAll} style={btnStyle}>⏸ Pause All</button>
      <button onClick={onStopAll} style={{ ...btnStyle, color: "#f87171", borderColor: "#f8717155" }}>■ Stop All</button>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#1e1e30", border: "1px solid #2d2d4e", color: "#888",
  borderRadius: 5, padding: "4px 10px", fontSize: 11, cursor: "pointer"
};
```

- [ ] **Step 2: Write `ui/src/components/NodeDetailPanel.tsx`**

```tsx
import type { AgentNode } from "../types";

interface Props {
  agent: AgentNode;
  onClose: () => void;
  onCommand: (cmd: object) => void;
}

export function NodeDetailPanel({ agent, onClose, onCommand }: Props) {
  const pendingCalls = agent.tool_calls.filter((tc) => tc.pending);
  const doneCalls = agent.tool_calls.filter((tc) => !tc.pending);

  return (
    <div style={{
      width: 300, background: "#111120", borderLeft: "1px solid #1e1e30",
      display: "flex", flexDirection: "column", overflow: "hidden"
    }}>
      {/* Header */}
      <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid #1e1e30", display: "flex", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{agent.name}</div>
          <span style={{ ...badgeStyle, ...statusBadge(agent.status) }}>{agent.status}</span>
        </div>
        <button onClick={onClose} style={closeBtnStyle}>✕</button>
      </div>

      {/* Controls */}
      <div style={{ padding: "10px 16px", borderBottom: "1px solid #1e1e30", display: "flex", gap: 6 }}>
        <button style={ctrlBtnStyle} onClick={() => onCommand({ kind: "agent_pause", agent_id: agent.id })}>⏸ Pause</button>
        <button style={ctrlBtnStyle} onClick={() => onCommand({ kind: "agent_stop", agent_id: agent.id })}>■ Stop</button>
        <button style={{ ...ctrlBtnStyle, color: "#a78bfa", borderColor: "#a78bfa55" }}
          onClick={() => onCommand({ kind: "agent_resume", agent_id: agent.id })}>▶ Resume</button>
      </div>

      {/* Tool calls */}
      <div style={{ padding: "10px 16px 4px", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: "#444" }}>
        Tool Calls
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {pendingCalls.map((tc) => (
          <div key={tc.call_id} style={{ padding: "8px 16px", borderBottom: "1px solid #1a1a28", background: "#1e1a10", borderLeft: "2px solid #f59e0b" }}>
            <div style={{ fontFamily: "monospace", fontSize: 10, color: "#a78bfa" }}>{tc.name}</div>
            <div style={{ fontFamily: "monospace", fontSize: 9, color: "#555", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {JSON.stringify(tc.args)}
            </div>
            <div style={{ fontSize: 9, color: "#f59e0b", marginTop: 3 }}>⏳ Waiting for approval</div>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <button style={approveBtn} onClick={() => onCommand({ kind: "tool_approve", agent_id: agent.id, call_id: tc.call_id })}>✓ Approve</button>
              <button style={denyBtn} onClick={() => onCommand({ kind: "tool_deny", agent_id: agent.id, call_id: tc.call_id })}>✗ Deny</button>
            </div>
          </div>
        ))}
        {doneCalls.map((tc) => (
          <div key={tc.call_id} style={{ padding: "8px 16px", borderBottom: "1px solid #1a1a28" }}>
            <div style={{ fontFamily: "monospace", fontSize: 10, color: "#a78bfa" }}>{tc.name}</div>
            <div style={{ fontFamily: "monospace", fontSize: 9, color: "#555", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {JSON.stringify(tc.args)}
            </div>
            <div style={{ fontFamily: "monospace", fontSize: 9, color: "#34d399" }}>
              ✓ {String(tc.result ?? "").slice(0, 60)}{tc.duration_ms != null ? ` (${tc.duration_ms}ms)` : ""}
            </div>
          </div>
        ))}
      </div>

      {/* Inject */}
      <div style={{ padding: "10px 16px", borderTop: "1px solid #1e1e30" }}>
        <textarea
          id={`inject-${agent.id}`}
          rows={2}
          placeholder="Inject instruction to this agent..."
          style={{
            width: "100%", background: "#1a1a2e", border: "1px solid #2d2d4e",
            borderRadius: 6, color: "#ccc", fontSize: 11, padding: "7px 10px",
            resize: "none", fontFamily: "inherit", outline: "none"
          }}
        />
        <button
          style={{ marginTop: 6, width: "100%", background: "#a78bfa22", border: "1px solid #a78bfa44", color: "#a78bfa", borderRadius: 5, padding: 6, fontSize: 10, cursor: "pointer" }}
          onClick={() => {
            const el = document.getElementById(`inject-${agent.id}`) as HTMLTextAreaElement;
            if (el.value.trim()) {
              onCommand({ kind: "inject_message", agent_id: agent.id, content: el.value });
              el.value = "";
            }
          }}
        >
          ↑ Send to agent
        </button>
      </div>
    </div>
  );
}

const badgeStyle: React.CSSProperties = { padding: "2px 7px", borderRadius: 3, fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em" };
const closeBtnStyle: React.CSSProperties = { background: "none", border: "none", color: "#333", cursor: "pointer", fontSize: 12 };
const ctrlBtnStyle: React.CSSProperties = { flex: 1, background: "#1e1e30", border: "1px solid #2d2d4e", color: "#888", borderRadius: 5, padding: "6px 4px", fontSize: 10, textAlign: "center", cursor: "pointer" };
const approveBtn: React.CSSProperties = { flex: 1, padding: "4px 8px", borderRadius: 4, fontSize: 9, cursor: "pointer", background: "#34d39933", color: "#34d399", border: "1px solid #34d39955", fontWeight: 600 };
const denyBtn: React.CSSProperties = { flex: 1, padding: "4px 8px", borderRadius: 4, fontSize: 9, cursor: "pointer", background: "#f8717133", color: "#f87171", border: "1px solid #f8717155", fontWeight: 600 };

function statusBadge(status: string): React.CSSProperties {
  const map: Record<string, React.CSSProperties> = {
    running: { background: "#3b82f622", color: "#60a5fa" },
    complete: { background: "#34d39922", color: "#34d399" },
    waiting: { background: "#f59e0b22", color: "#f59e0b" },
    paused: { background: "#f59e0b22", color: "#f59e0b" },
    error: { background: "#f8717122", color: "#f87171" },
  };
  return map[status] ?? {};
}
```

- [ ] **Step 3: Write `ui/src/components/MessageThread.tsx`**

```tsx
import type { MessageEdge, AgentNode } from "../types";

interface Props {
  edge: MessageEdge;
  agents: Record<string, AgentNode>;
  onClose: () => void;
}

export function MessageThread({ edge, agents, onClose }: Props) {
  const fromName = agents[edge.from_agent_id]?.name ?? edge.from_agent_id;
  const toName = agents[edge.to_agent_id]?.name ?? edge.to_agent_id;

  return (
    <div style={{ width: 300, background: "#111120", borderLeft: "1px solid #1e1e30", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid #1e1e30", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#a78bfa", display: "inline-block" }} />
        <span style={{ fontSize: 11, fontWeight: 600 }}>{fromName} ↔ {toName}</span>
        <span style={{ marginLeft: "auto", fontSize: 9, color: "#444" }}>{edge.messages.length} messages</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#333", cursor: "pointer", fontSize: 12 }}>✕</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {edge.messages.map((msg, i) => {
          const senderName = agents[msg.from]?.name ?? msg.from;
          const recipientName = agents[msg.to]?.name ?? msg.to;
          const isLast = i === edge.messages.length - 1;
          return (
            <div key={i} style={{ padding: "8px 14px", borderBottom: "1px solid #1a1a28", background: isLast ? "#14142a" : undefined }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, color: "#444", marginBottom: 3 }}>
                <span style={{ fontWeight: 700, color: "#a78bfa" }}>{senderName}</span>
                <span>→</span>
                <span style={{ fontWeight: 700, color: "#60a5fa" }}>{recipientName}</span>
                <span style={{ marginLeft: "auto" }}>{new Date(msg.timestamp * 1000).toLocaleTimeString()}</span>
              </div>
              <div style={{ fontSize: 10, color: isLast ? "#c4b5fd" : "#888", lineHeight: 1.5 }}>{msg.content}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/
git commit -m "feat: UI panels — TopBar, NodeDetailPanel, MessageThread"
```

---

## Task 9: Integration smoke test + example

**Files:**
- Create: `examples/basic_run.py`

- [ ] **Step 1: Build relay**

```bash
cd ~/Desktop/AgentViz/relay
npm run build
```

Expected: `dist/index.js` created, no TypeScript errors.

- [ ] **Step 2: Build UI**

```bash
cd ~/Desktop/AgentViz/ui
npm run build
```

Expected: `dist/` created, no TypeScript errors.

- [ ] **Step 3: Write `examples/basic_run.py`**

```python
"""
Minimal AgentViz smoke test.
Run: python examples/basic_run.py
Then open http://localhost:3333 in your browser.
"""
import asyncio
import sys
sys.path.insert(0, "sdk")

from agentviz import session

async def main():
    s = session(name="smoke-test")
    await s.connect()
    print("Session started. Open http://localhost:3333")

    async with s.agent("orchestrator") as orch:
        await s.send_message("orchestrator", "orchestrator", "Starting run...")

        async with s.agent("worker-a", parent_id=orch.agent_id) as worker:
            await worker.set_status("waiting")
            result = await worker.tool_call(
                name="fetch_data",
                args={"source": "api"},
                fn=lambda: {"rows": 42},
                approval_timeout=30.0,
            )
            print(f"Tool result: {result}")
            await s.send_message("worker-a", "orchestrator", f"Fetched {result['rows']} rows.")

        async with s.agent("worker-b", parent_id=orch.agent_id):
            await asyncio.sleep(1)

    await s.close()
    print("Done.")

asyncio.run(main())
```

- [ ] **Step 4: Run the smoke test**

```bash
cd ~/Desktop/AgentViz
python examples/basic_run.py
```

Expected output:
```
Session started. Open http://localhost:3333
# (open browser, approve the tool call)
Tool result: {'rows': 42}
Done.
```

Open `http://localhost:3333` in your browser. You should see:
- The `orchestrator` node (purple, root)
- Two child nodes `worker-a` and `worker-b` (blue, running)
- A pending tool call approval row in `worker-a`'s detail panel
- A message edge between `worker-a` and `orchestrator` after approval

- [ ] **Step 5: Commit**

```bash
git add examples/
git commit -m "feat: basic_run.py smoke test example"
```

---

## Done

The MVP is complete when:
- [ ] `pip install agentviz` works from PyPI (or local install)
- [ ] `python examples/basic_run.py` shows a live graph in the browser
- [ ] Tool call approval flow works end-to-end
- [ ] Message edges expand to show thread content
- [ ] All SDK tests pass (`pytest sdk/tests/`)
- [ ] All relay tests pass (`npx jest --forceExit`)
- [ ] All UI store tests pass (`npx vitest run`)
