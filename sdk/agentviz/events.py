from dataclasses import dataclass, field, asdict
from typing import Any, Literal
import time
import uuid

EventKind = Literal[
    "session_start", "agent_spawn", "agent_status", "tool_call_pending",
    "tool_result", "tool_denied", "agent_message", "log", "agent_complete",
    "command_ack", "usage", "outcome", "credit_report", "recommendation_report",
    "operation_start", "operation_tick", "operation_end"
]
CommandKind = Literal[
    "tool_approve", "tool_deny", "agent_pause", "agent_resume",
    "agent_stop", "inject_message", "spawn_agent"
]
AgentStatus = Literal["running", "waiting", "complete", "error", "paused"]

# --- Operation taxonomy (agentic/workflow operations as first-class events) ---
OperationKind = Literal[
    "loop", "goal", "schedule", "workflow", "phase", "spawn", "message",
    "skill", "mcp", "plan_mode", "worktree", "background", "monitor", "remote",
    "todo", "compact", "hook"
]
OperationFamily = Literal["recurrence", "orchestration", "command", "mode", "state"]

# Single source of truth mapping op_type -> family (mirrored in ui/src/types.ts).
FAMILY_OF: dict[str, str] = {
    "loop": "recurrence",
    "goal": "recurrence",
    "schedule": "recurrence",
    "workflow": "orchestration",
    "phase": "orchestration",
    "spawn": "orchestration",
    "message": "orchestration",
    "skill": "command",
    "mcp": "command",
    "plan_mode": "mode",
    "worktree": "mode",
    "background": "mode",
    "monitor": "mode",
    "remote": "mode",
    "todo": "state",
    "compact": "state",
    "hook": "state",
}


def _now() -> float:
    return time.time()

def _id() -> str:
    return str(uuid.uuid4())


@dataclass
class SessionStartEvent:
    kind: Literal["session_start"] = field(default="session_start", init=False)
    name: str = ""
    dry_run: bool = False   # mock-side-effects re-run mode (no external side effects)
    # v2 multi-session: origin + grounding context for the tab (all optional)
    source: Literal["claude-code", "shell", "sdk"] | None = None
    cwd: str | None = None
    git_branch: str | None = None
    timestamp: float = field(default_factory=_now)

@dataclass
class CommandAckEvent:
    kind: Literal["command_ack"] = field(default="command_ack", init=False)
    cmd_id: str = ""
    status: Literal["applied", "failed"] = "applied"
    timestamp: float = field(default_factory=_now)

@dataclass
class AgentSpawnEvent:
    kind: Literal["agent_spawn"] = field(default="agent_spawn", init=False)
    agent_id: str = field(default_factory=_id)
    parent_id: str | None = None
    name: str = ""
    timestamp: float = field(default_factory=_now)

@dataclass
class AgentStatusEvent:
    kind: Literal["agent_status"] = field(default="agent_status", init=False)
    agent_id: str = ""
    status: AgentStatus = "running"
    timestamp: float = field(default_factory=_now)

@dataclass
class ToolCallPendingEvent:
    kind: Literal["tool_call_pending"] = field(default="tool_call_pending", init=False)
    agent_id: str = ""
    call_id: str = field(default_factory=_id)
    name: str = ""
    args: dict[str, Any] = field(default_factory=dict)
    timeout_s: float = 30.0
    timestamp: float = field(default_factory=_now)

@dataclass
class ToolResultEvent:
    kind: Literal["tool_result"] = field(default="tool_result", init=False)
    agent_id: str = ""
    call_id: str = ""
    result: Any = None
    duration_ms: int = 0
    simulated: bool = False   # True => dry-run mock/replay; fn was NOT executed
    timestamp: float = field(default_factory=_now)

@dataclass
class ToolDeniedEvent:
    kind: Literal["tool_denied"] = field(default="tool_denied", init=False)
    agent_id: str = ""
    call_id: str = ""
    name: str = ""
    reason: Literal["denied", "timeout"] = "denied"
    timestamp: float = field(default_factory=_now)

@dataclass
class AgentMessageEvent:
    kind: Literal["agent_message"] = field(default="agent_message", init=False)
    from_agent_id: str = ""
    to_agent_id: str = ""
    content: str = ""
    timestamp: float = field(default_factory=_now)

@dataclass
class LogEvent:
    kind: Literal["log"] = field(default="log", init=False)
    agent_id: str = ""
    content: str = ""
    level: Literal["info", "warn", "error"] = "info"
    timestamp: float = field(default_factory=_now)

@dataclass
class UsageEvent:
    kind: Literal["usage"] = field(default="usage", init=False)
    agent_id: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    model: str | None = None
    cost_usd: float | None = None
    timestamp: float = field(default_factory=_now)

@dataclass
class OutcomeEvent:
    kind: Literal["outcome"] = field(default="outcome", init=False)
    # agent_id=None => run-level (terminal) outcome; routes to the _session seq stream.
    agent_id: str | None = None
    channel: str = "reward"           # named reward channel (orthogonal signals)
    value: float = 0.0                # binary->1.0/0.0; graded->raw; thumbs->+1/-1/0
    scale: Literal["binary", "unit", "score", "delta"] = "binary"
    value_min: float | None = None    # optional bounds for "score" normalization
    value_max: float | None = None
    stage: Literal["terminal", "intermediate"] = "terminal"
    # source = WHERE the number came from (a fact, never an LLM opinion). The UI
    # flags source="llm_judge" as NON-GROUNDED.
    source: str = "manual"
    measured: bool = True
    # detail may carry result_agent_ids: list[str] to declare the sink set explicitly.
    detail: dict[str, Any] = field(default_factory=dict)
    # Rung 2/3 replay bookkeeping (inert until persistence lands).
    run_id: str | None = None
    ablated_agent_id: str | None = None
    baseline_run_id: str | None = None
    baseline_value: float | None = None
    timestamp: float = field(default_factory=_now)

@dataclass
class CreditReportEvent:
    kind: Literal["credit_report"] = field(default="credit_report", init=False)
    # method tags HOW credit was computed (a grounded method, never an LLM opinion).
    method: Literal["counterfactual", "shapley", "densified"] = "counterfactual"
    channel: str = "reward"
    # each entry: {agent, credit, ci:[lo,hi]|None, credit_state|None, basis}
    agents: list[dict[str, Any]] = field(default_factory=list)
    timestamp: float = field(default_factory=_now)

@dataclass
class RecommendationReportEvent:
    kind: Literal["recommendation_report"] = field(default="recommendation_report", init=False)
    channel: str = "reward"
    # each entry: {rule, severity, agents:[...], action, rationale, savings_usd|None}
    recommendations: list[dict[str, Any]] = field(default_factory=list)
    timestamp: float = field(default_factory=_now)

@dataclass
class AgentCompleteEvent:
    kind: Literal["agent_complete"] = field(default="agent_complete", init=False)
    agent_id: str = ""
    exit_status: Literal["ok", "error", "stopped"] = "ok"
    summary: str = ""
    timestamp: float = field(default_factory=_now)

@dataclass
class OperationStartEvent:
    kind: Literal["operation_start"] = field(default="operation_start", init=False)
    op_id: str = field(default_factory=_id)
    op_type: OperationKind = "loop"
    family: OperationFamily = "recurrence"
    parent_op_id: str | None = None
    agent_id: str | None = None       # null => session-level operation
    label: str = ""
    status: Literal["running", "waiting", "recurring"] = "running"
    detail: dict[str, Any] = field(default_factory=dict)
    timestamp: float = field(default_factory=_now)

@dataclass
class OperationTickEvent:
    kind: Literal["operation_tick"] = field(default="operation_tick", init=False)
    op_id: str = ""
    n: int = 0                        # iteration / beat index (0-based)
    label: str = ""
    status: Literal["running", "waiting", "recurring"] = "running"
    detail: dict[str, Any] = field(default_factory=dict)
    timestamp: float = field(default_factory=_now)

@dataclass
class OperationEndEvent:
    kind: Literal["operation_end"] = field(default="operation_end", init=False)
    op_id: str = ""
    status: Literal["complete", "error", "stopped", "expired"] = "complete"
    summary: str = ""
    detail: dict[str, Any] = field(default_factory=dict)
    timestamp: float = field(default_factory=_now)


def serialize(event: object) -> dict:
    return asdict(event)  # type: ignore[arg-type]
