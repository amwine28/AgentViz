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
from .exceptions import AgentStopped, ToolCallDenied

if TYPE_CHECKING:
    from .relay_client import RelayClient


class _ToolDenied(Exception):
    pass


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
    ) -> Any:
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        event = ToolCallPendingEvent(
            agent_id=self.agent_id, name=name, args=args, timeout_s=approval_timeout
        )
        call_id = event.call_id
        self.register_pending_tool_call(call_id, future)

        await self._relay.send(serialize(event))

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
