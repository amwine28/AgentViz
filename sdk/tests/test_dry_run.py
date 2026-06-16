"""Dry-run / mock-side-effects safety layer (§6.3) — the hard prerequisite the spec
gates live Rung 2/3 on. THE GUARANTEE: in dry_run, a tool that is not explicitly
declared safe-to-run is NEVER executed; its fn is never invoked."""
import asyncio
import json
import pytest
import websockets
from agentviz import session, ToolCallDenied


def auto_approve_relay(events_received):
    async def fake_relay(ws):
        async for raw in ws:
            m = json.loads(raw)
            events_received.append(m)
            if m["kind"] == "tool_call_pending":
                await ws.send(json.dumps({
                    "kind": "tool_approve", "agent_id": m["agent_id"], "call_id": m["call_id"],
                }))
    return fake_relay


async def _run(port, dry_run, fn, **call_kwargs):
    events, called = [], {"value": False}

    def wrapped():
        called["value"] = True
        return fn()

    async with websockets.serve(auto_approve_relay(events), "localhost", port):
        s = session(name="t", port=port, autostart_relay=False, dry_run=dry_run)
        await s.connect()
        result = {"value": None}
        async with s.agent("worker") as a:
            result["value"] = await a.tool_call(name="t", args={}, fn=wrapped,
                                                approval_timeout=2.0, **call_kwargs)
        await s.close()
    return events, called, result


@pytest.mark.asyncio
async def test_dry_run_never_executes_external_side_effecting_tool(unused_tcp_port):
    events, called, result = await _run(unused_tcp_port, True, lambda: "SENT", side_effect="external")
    assert called["value"] is False                       # THE GUARANTEE
    assert result["value"] is None                        # mocked, not the real result
    sims = [e for e in events if e["kind"] == "tool_result" and e.get("simulated")]
    assert len(sims) == 1


@pytest.mark.asyncio
async def test_dry_run_default_is_fail_safe_not_executed(unused_tcp_port):
    # no side_effect declared -> treated as unsafe -> NOT executed in dry_run
    events, called, _ = await _run(unused_tcp_port, True, lambda: "SENT")
    assert called["value"] is False


@pytest.mark.asyncio
async def test_dry_run_invalid_class_is_fail_safe_not_executed(unused_tcp_port):
    # a typo'd / unknown class must NOT fall through to execution (whitelist, not blacklist)
    events, called, _ = await _run(unused_tcp_port, True, lambda: "SENT", side_effect="externl")
    assert called["value"] is False


@pytest.mark.asyncio
async def test_dry_run_executes_pure_tool(unused_tcp_port):
    events, called, result = await _run(unused_tcp_port, True, lambda: 42, side_effect="pure")
    assert called["value"] is True
    assert result["value"] == 42


@pytest.mark.asyncio
async def test_dry_run_executes_live_required_tool(unused_tcp_port):
    events, called, result = await _run(unused_tcp_port, True, lambda: "live", side_effect="live_required")
    assert called["value"] is True
    assert result["value"] == "live"


@pytest.mark.asyncio
async def test_dry_run_replays_replayable_without_calling_fn(unused_tcp_port):
    events, called, result = await _run(unused_tcp_port, True, lambda: "REAL",
                                        side_effect="replayable", replay_value="baseline")
    assert called["value"] is False
    assert result["value"] == "baseline"                  # the recorded baseline, fn not run


@pytest.mark.asyncio
async def test_normal_mode_executes_external_tool(unused_tcp_port):
    # dry_run=False -> normal behavior preserved: external fn DOES run
    events, called, result = await _run(unused_tcp_port, False, lambda: "SENT", side_effect="external")
    assert called["value"] is True
    assert result["value"] == "SENT"
    assert not any(e.get("simulated") for e in events if e["kind"] == "tool_result")


@pytest.mark.asyncio
async def test_nested_agents_inherit_dry_run(unused_tcp_port):
    events, called = [], {"value": False}
    async with websockets.serve(auto_approve_relay(events), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False, dry_run=True)
        await s.connect()
        async with s.agent("orch") as orch:
            async with s.agent("child", parent_id=orch.agent_id) as child:
                await child.tool_call(name="t", args={}, fn=lambda: called.__setitem__("value", True),
                                      side_effect="external", approval_timeout=2.0)
        await s.close()
    assert called["value"] is False                       # child inherits dry_run


@pytest.mark.asyncio
async def test_dry_run_runs_agent_reasoning_live_while_mocking_external_tools(unused_tcp_port):
    """Both halves of §6.3 together (from the adversarial audit): the agent's own
    reasoning runs LIVE (the safety layer never blocks it) while every external
    side-effecting tool is MOCKED — so a counterfactual re-run stays meaningful
    yet produces zero real side effects."""
    events = []
    reasoning_ran = {"value": False}
    external_called = {"value": False}
    async with websockets.serve(auto_approve_relay(events), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False, dry_run=True)
        await s.connect()
        async with s.agent("worker") as a:
            reasoning_ran["value"] = True            # the agent body runs live
            await a.log("reasoning step")
            await a.tool_call(name="charge_card", args={},
                              fn=lambda: external_called.__setitem__("value", True),
                              side_effect="external", approval_timeout=2.0)
        await s.close()
    assert reasoning_ran["value"] is True            # reasoning executed
    assert external_called["value"] is False         # external side effect mocked
    assert any(e["kind"] == "log" for e in events)   # live telemetry emitted, side-effect-free


@pytest.mark.asyncio
async def test_session_start_carries_dry_run_flag(unused_tcp_port):
    events = []
    async with websockets.serve(auto_approve_relay(events), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False, dry_run=True)
        await s.connect()
        await s.close()
    start = next(e for e in events if e["kind"] == "session_start")
    assert start["dry_run"] is True
