"""credit_report event: a harness (re-run / Shapley / densification) publishes its
measured per-agent credit so the UI can surface it. The values are computed externally
(grounded) — the SDK is just the transport."""
import asyncio
import json
import pytest
import websockets
from agentviz import session


def make_capture_relay(events_received):
    async def fake_relay(ws):
        async for raw in ws:
            events_received.append(json.loads(raw))
    return fake_relay


@pytest.mark.asyncio
async def test_report_credit_emits_credit_report_event(unused_tcp_port):
    events = []
    async with websockets.serve(make_capture_relay(events), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        await s.report_credit(
            method="counterfactual",
            channel="tests",
            agents=[
                {"agent": "retriever", "credit": 0.70, "ci": [0.69, 0.71], "credit_state": "estimated", "basis": "measured"},
                {"agent": "stylist", "credit": 0.00, "ci": [-0.01, 0.01], "credit_state": "tight_null", "basis": "measured"},
            ],
        )
        await s.close()

    reports = [e for e in events if e["kind"] == "credit_report"]
    assert len(reports) == 1
    r = reports[0]
    assert r["method"] == "counterfactual"
    assert r["channel"] == "tests"
    assert len(r["agents"]) == 2
    assert r["agents"][0]["agent"] == "retriever"
    assert r["agents"][0]["ci"] == [0.69, 0.71]
    assert r["agents"][0]["credit_state"] == "estimated"
    assert r.get("run_id") == s.run_id      # stamped like every event
