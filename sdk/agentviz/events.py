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
