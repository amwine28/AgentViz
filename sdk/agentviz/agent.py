import asyncio
import inspect
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, Literal
from .events import (
    AgentSpawnEvent, AgentStatusEvent, AgentCompleteEvent,
    ToolCallPendingEvent, ToolResultEvent, ToolDeniedEvent, LogEvent,
    UsageEvent, OutcomeEvent, AgentStatus, serialize, _id
)
from .operations import Operation, _OperationContext
from .exceptions import AgentStopped, ToolCallDenied

if TYPE_CHECKING:
    from .relay_client import RelayClient


class _ToolDenied(Exception):
    pass


# Tool classes that are SAFE to execute during a dry-run re-run. Everything else
# (external, replayable, unknown, typo'd, unspecified) is NOT executed — a whitelist,
# so misclassification fails safe rather than leaking a real side effect.
#
# Threat model (adversarially audited — 0 confirmed leaks across 6 candidate findings).
# The guarantee: a tool function routed through tool_call cannot execute in dry-run unless
# its class is "pure"/"live_required". What it deliberately does NOT cover (honest scope):
#   - fn invoked OUTSIDE tool_call (the SDK can't see it) — caller responsibility.
#   - a tool the CALLER mislabels "pure"/"live_required" (executes by their declaration).
#   - the credit-quality concern that a fixed `replay_value` biases ablation deltas — that
#     is the classification contract's job + the (future) Rung-2 fresh-sample guardrail,
#     not this side-effect layer's.
_DRY_RUN_EXECUTABLE = frozenset({"pure", "live_required"})


class Agent:
    def __init__(self, name: str, relay: "RelayClient", parent_id: str | None = None,
                 dry_run: bool = False):
        self.agent_id: str = _id()
        self.name = name
        self._relay = relay
        self._parent_id = parent_id
        self._dry_run = dry_run
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

    def is_ablated(self) -> bool:
        """True only for a neutralized agent in a counterfactual re-run (see _NeutralAgent)."""
        return False

    def is_paused(self) -> bool:
        return not self._paused.is_set()

    async def wait_if_paused(self) -> None:
        await self._paused.wait()
        if self._stopped:
            raise AgentStopped(self.agent_id)

    def _on_pause(self, cmd: dict) -> bool:
        if cmd.get("agent_id") in (self.agent_id, None):
            self._paused.clear()
            return True
        return False

    def _on_resume(self, cmd: dict) -> bool:
        if cmd.get("agent_id") in (self.agent_id, None):
            self._paused.set()
            return True
        return False

    def _on_stop(self, cmd: dict) -> bool:
        if cmd.get("agent_id") in (self.agent_id, None):
            self._stopped = True
            self._paused.set()
            return True
        return False

    def _on_inject(self, cmd: dict) -> bool:
        if cmd.get("agent_id") in (self.agent_id, None):
            self.injected_messages.put_nowait(cmd.get("content", ""))
            return True
        return False

    def register_pending_tool_call(self, call_id: str, future: asyncio.Future) -> None:
        self._pending_tool_calls[call_id] = future

    def resolve_tool_call(self, call_id: str, approved: bool) -> bool:
        fut = self._pending_tool_calls.pop(call_id, None)
        if fut and not fut.done():
            if approved:
                fut.set_result(True)
            else:
                fut.set_exception(_ToolDenied(call_id))
            return True
        return False

    async def log(self, content: str, level: Literal["info", "warn", "error"] = "info") -> None:
        await self._relay.send(serialize(
            LogEvent(agent_id=self.agent_id, content=content, level=level)
        ))

    async def report_usage(
        self,
        input_tokens: int = 0,
        output_tokens: int = 0,
        model: str | None = None,
        cost_usd: float | None = None,
    ) -> None:
        """Report LLM token/cost consumption for this agent. Feeds the
        efficiency audit — call it after each model interaction."""
        await self._relay.send(serialize(UsageEvent(
            agent_id=self.agent_id,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            model=model,
            cost_usd=cost_usd,
        )))

    async def report_outcome(
        self,
        value: float,
        channel: str = "reward",
        *,
        scale: Literal["binary", "unit", "score", "delta"] = "binary",
        stage: Literal["terminal", "intermediate"] = "intermediate",
        source: str = "manual",
        measured: bool = True,
        value_min: float | None = None,
        value_max: float | None = None,
        detail: dict | None = None,
    ) -> None:
        """Report a reward/outcome signal scoped to THIS agent. Defaults to an
        intermediate (per-handoff) signal — feeds credit assignment. The value
        must come from a verifiable fact (test, eval, metric), never an opinion."""
        await self._relay.send(serialize(OutcomeEvent(
            agent_id=self.agent_id, value=value, channel=channel, scale=scale,
            stage=stage, source=source, measured=measured,
            value_min=value_min, value_max=value_max, detail=detail or {},
        )))

    def operation(
        self,
        op_type: str,
        *,
        label: str = "",
        detail: dict[str, Any] | None = None,
        parent: "Operation | None" = None,
    ) -> _OperationContext:
        """Open an operation scoped to THIS agent (agent_id=self.agent_id). Returns an
        async context manager: __aenter__ emits operation_start and yields the live
        Operation handle; __aexit__ emits operation_end (status 'complete', or 'error'
        with summary=str(exc) if an exception propagates). ``parent`` nests this op
        under another (sets parent_op_id). Reuses this agent's relay send + seq-stamping."""
        return _OperationContext(
            relay=self._relay,
            op_type=op_type,  # type: ignore[arg-type]
            agent_id=self.agent_id,
            parent_op_id=parent.op_id if parent is not None else None,
            label=label,
            detail=detail,
        )

    async def _emit_tool_denied(
        self, call_id: str, name: str, reason: Literal["denied", "timeout"]
    ) -> None:
        await self._relay.send(serialize(
            ToolDeniedEvent(agent_id=self.agent_id, call_id=call_id, name=name, reason=reason)
        ))

    async def tool_call(
        self,
        name: str,
        args: dict,
        fn: Callable[[], Any],
        approval_timeout: float = 30.0,
        on_timeout: Literal["deny", "approve"] = "deny",
        side_effect: Literal["pure", "replayable", "external", "live_required"] = "external",
        replay_value: Any = None,
    ) -> Any:
        """Run a tool, gated by human approval and (in dry-run) by the side-effect
        safety layer. `side_effect` declares the tool's class:
          pure          — no external side effects, safe to run anytime.
          replayable    — deterministic external read; in dry-run, returns `replay_value`
                          (the recorded baseline) WITHOUT executing fn.
          external      — has side effects (send email, charge, write); in dry-run it is
                          MOCKED — fn is never executed (DEFAULT, fail-safe).
          live_required — must execute even in dry-run (explicit opt-in).
        GUARANTEE: in dry-run, only `pure`/`live_required` fns execute; anything else
        (incl. unknown/typo'd classes) is never invoked."""
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        event = ToolCallPendingEvent(
            agent_id=self.agent_id, name=name, args=args, timeout_s=approval_timeout
        )
        call_id = event.call_id
        self.register_pending_tool_call(call_id, future)

        await self._relay.send(serialize(event))

        if self._dry_run:
            # Automated re-run mode: no human in the loop, so the approval gate is
            # bypassed. Safety is unaffected — the side-effect choke point below still
            # mocks anything not in {pure, live_required}.
            self._pending_tool_calls.pop(call_id, None)
        else:
            try:
                await asyncio.wait_for(future, timeout=approval_timeout)
            except asyncio.TimeoutError:
                self._pending_tool_calls.pop(call_id, None)
                if on_timeout == "deny":
                    await self._emit_tool_denied(call_id, name, reason="timeout")
                    raise ToolCallDenied(call_id=call_id, tool_name=name)
            except _ToolDenied:
                await self._emit_tool_denied(call_id, name, reason="denied")
                raise ToolCallDenied(call_id=call_id, tool_name=name)

        # ---- side-effect safety choke point (the single place fn can run) ----
        # Whitelist: execute only when NOT in dry-run, or the tool is explicitly safe.
        if self._dry_run and side_effect not in _DRY_RUN_EXECUTABLE:
            result = replay_value if side_effect == "replayable" else None
            await self._relay.send(serialize(ToolResultEvent(
                agent_id=self.agent_id, call_id=call_id, result=result,
                duration_ms=0, simulated=True,
            )))
            return result

        t0 = time.monotonic()
        result = fn()
        if inspect.isawaitable(result):
            result = await result
        duration_ms = int((time.monotonic() - t0) * 1000)
        await self._relay.send(serialize(
            ToolResultEvent(agent_id=self.agent_id, call_id=call_id, result=result, duration_ms=duration_ms)
        ))
        return result

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


class _NeutralAgent(Agent):
    """A contribution-suppressing drop-in (re-run ablation). API-compatible with Agent so
    an unchanged workflow runs without edits. It still spawns/completes (visible in the
    world) but emits NOTHING peer-visible: tool fns never run, messages/outcome/usage/log
    are muted. This is the ABLATION gate — orthogonal to the dry_run safety gate. The
    workflow can additionally check `if a.is_ablated(): ...` to short-circuit the body and
    its spawn-cascade (the grounded way to remove an agent's contribution)."""

    def is_ablated(self) -> bool:
        return True

    async def tool_call(self, name, args, fn, *, side_effect="external", replay_value=None, **kw) -> Any:
        # NEVER invoke fn — this is ablation, not the dry_run safety mock.
        await self._relay.send(serialize(ToolResultEvent(
            agent_id=self.agent_id, call_id=_id(), result=None, duration_ms=0, simulated=True,
        )))
        return None

    async def report_outcome(self, *a, **k) -> None:  # defensive (C1 forbids agent-scope reward anyway)
        return None

    async def report_usage(self, *a, **k) -> None:
        return None

    async def log(self, *a, **k) -> None:
        return None
