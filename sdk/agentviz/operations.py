"""Operation handles — live emission of agentic/workflow operations.

An ``Operation`` is the runtime handle returned by ``Session.operation(...)`` /
``Agent.operation(...)`` (async context managers in session.py / agent.py). It
holds the relay client + the run scope (agent_id and op_id) and emits
``operation_tick`` / nested ``operation_start`` events over the SAME relay
transport + seq-stamping path as every other event (no new transport).

GROUNDED-ONLY: a tick should carry a real measured fact in ``detail`` (a loop
iteration count, a schedule fire, a phase transition). An operation with zero
measured ticks renders honest-unknown downstream — never a faked progress bar.

The context-manager lifecycle (start on __aenter__, end on __aexit__) lives in
session.py / agent.py so it can reuse their existing relay send path; this module
owns the handle's tick/child behavior and the family derivation.
"""
from typing import TYPE_CHECKING, Any, Literal

from .events import (
    FAMILY_OF, OperationKind, OperationStartEvent, OperationTickEvent, serialize, _id,
)

if TYPE_CHECKING:
    from .relay_client import RelayClient


def family_of(op_type: str) -> str:
    """Derive the OperationFamily for an op_type via the single-source-of-truth map.

    Unknown op_types fall back to ``state`` (a free-form bucket) rather than
    raising — the taxonomy is DATA, so an unrecognized kind degrades gracefully
    instead of crashing live emission."""
    return FAMILY_OF.get(op_type, "state")


class Operation:
    """A live operation handle. Created by Session/Agent.operation(...).

    Carries ``op_id`` and the owning scope (``agent_id``, possibly None for a
    session-level op). ``.tick()`` emits an ``operation_tick``; ``.child()``
    opens a nested operation (e.g. workflow -> phase) wired to this op via
    ``parent_op_id`` and inheriting this op's ``agent_id`` scope."""

    def __init__(
        self,
        relay: "RelayClient",
        op_type: OperationKind,
        *,
        op_id: str | None = None,
        agent_id: str | None = None,
        parent_op_id: str | None = None,
        label: str = "",
    ):
        self._relay = relay
        self.op_id: str = op_id or _id()
        self.op_type: OperationKind = op_type
        self.family: str = family_of(op_type)
        self.agent_id: str | None = agent_id
        self.parent_op_id: str | None = parent_op_id
        self.label: str = label
        # Auto-incrementing beat index used when .tick() is called without an
        # explicit n, so a self-paced loop still gets 0-based monotonic ticks.
        self._next_n: int = 0

    async def _emit_start(
        self,
        *,
        status: Literal["running", "waiting", "recurring"] = "running",
        detail: dict[str, Any] | None = None,
    ) -> None:
        """Emit this operation's operation_start. Called from the context-manager
        __aenter__ in session.py / agent.py (kept here so the event shape lives
        with the handle)."""
        await self._relay.send(serialize(OperationStartEvent(
            op_id=self.op_id,
            op_type=self.op_type,
            family=self.family,  # type: ignore[arg-type]
            parent_op_id=self.parent_op_id,
            agent_id=self.agent_id,
            label=self.label,
            status=status,
            detail=detail or {},
        )))

    async def tick(
        self,
        n: int | None = None,
        *,
        label: str = "",
        status: Literal["running", "waiting", "recurring"] = "running",
        detail: dict[str, Any] | None = None,
    ) -> int:
        """Emit one beat (operation_tick) for this operation. ``n`` is the 0-based
        iteration index; when omitted it auto-increments. Returns the n used."""
        if n is None:
            n = self._next_n
        # Keep the auto counter ahead of any explicit n so mixing styles stays monotonic.
        self._next_n = max(self._next_n, n + 1)
        await self._relay.send(serialize(OperationTickEvent(
            op_id=self.op_id,
            n=n,
            label=label or self.label,
            status=status,
            detail=detail or {},
        )))
        return n

    def child(
        self,
        op_type: OperationKind,
        label: str = "",
        detail: dict[str, Any] | None = None,
    ):
        """Open a nested operation under this one (e.g. workflow -> phase).

        Returns an async context manager (same lifecycle as Session/Agent.operation):
        the child inherits this op's ``agent_id`` scope and is wired to it via
        ``parent_op_id``. ``__aenter__`` emits operation_start with ``detail``;
        ``__aexit__`` emits operation_end (status 'complete', or 'error' if an
        exception propagates)."""
        return _OperationContext(
            relay=self._relay,
            op_type=op_type,
            agent_id=self.agent_id,
            parent_op_id=self.op_id,
            label=label,
            detail=detail,
        )


class _OperationContext:
    """Async context manager that emits operation_start on enter and operation_end
    on exit, yielding the live Operation handle. Shared by Session.operation,
    Agent.operation, and Operation.child so the lifecycle lives in one place."""

    def __init__(
        self,
        relay: "RelayClient",
        op_type: OperationKind,
        *,
        agent_id: str | None = None,
        parent_op_id: str | None = None,
        label: str = "",
        detail: dict[str, Any] | None = None,
        status: Literal["running", "waiting", "recurring"] = "running",
    ):
        self._op = Operation(
            relay=relay,
            op_type=op_type,
            agent_id=agent_id,
            parent_op_id=parent_op_id,
            label=label,
        )
        self._start_detail = detail
        self._start_status = status

    async def __aenter__(self) -> Operation:
        await self._op._emit_start(status=self._start_status, detail=self._start_detail)
        return self._op

    async def __aexit__(self, exc_type, exc, tb) -> Literal[False]:
        # Local import to avoid a module-load cycle (events <- operations only).
        from .events import OperationEndEvent
        if exc is not None:
            await self._op._relay.send(serialize(OperationEndEvent(
                op_id=self._op.op_id, status="error", summary=str(exc),
            )))
        else:
            await self._op._relay.send(serialize(OperationEndEvent(
                op_id=self._op.op_id, status="complete", summary="",
            )))
        return False  # never suppress an exception
