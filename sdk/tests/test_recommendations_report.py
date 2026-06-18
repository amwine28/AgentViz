"""recommendation_report event: a harness publishes the grounded recommendations (prune /
harden / sample more / regression) so the UI surfaces the DECISION, not just the readout.
The recommendations are computed externally (recommend.py) — the SDK is only transport."""
import json
import pytest
import websockets
from agentviz import session
from agentviz.recommend import Recommendation


def make_capture_relay(events_received):
    async def fake_relay(ws):
        async for raw in ws:
            events_received.append(json.loads(raw))
    return fake_relay


@pytest.mark.asyncio
async def test_report_recommendations_emits_event(unused_tcp_port):
    events = []
    async with websockets.serve(make_capture_relay(events), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        await s.report_recommendations([
            Recommendation(rule="prune_candidate", severity="medium", agents=["stylist"],
                           action="Review 'stylist' for removal", rationale="credit ~0 on quality",
                           savings_usd=0.006),
        ], channel="quality")
        await s.close()

    reports = [e for e in events if e["kind"] == "recommendation_report"]
    assert len(reports) == 1
    r = reports[0]
    assert r["channel"] == "quality"
    assert len(r["recommendations"]) == 1
    rec = r["recommendations"][0]
    assert rec["rule"] == "prune_candidate"
    assert rec["severity"] == "medium"
    assert rec["agents"] == ["stylist"]
    assert rec["savings_usd"] == 0.006
    assert r.get("run_id") == s.run_id          # stamped like every event


@pytest.mark.asyncio
async def test_report_recommendations_accepts_plain_dicts(unused_tcp_port):
    events = []
    async with websockets.serve(make_capture_relay(events), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        await s.report_recommendations(
            [{"rule": "regression", "severity": "high", "agents": ["verifier"],
              "action": "Investigate", "rationale": "dropped", "savings_usd": None}])
        await s.close()
    rec = [e for e in events if e["kind"] == "recommendation_report"][0]["recommendations"][0]
    assert rec["rule"] == "regression" and rec["agents"] == ["verifier"]
