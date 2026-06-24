"""Re-run grouping wire: a re-run carries baseline_run_id so the Logs panel can
nest it under the base run (the relay's listRuns reads the field; the UI groups)."""
from agentviz.session import Session
from agentviz.events import SessionStartEvent, serialize


def test_session_run_id_and_baseline_plumb_through():
    base = Session(name="rerun-probe", run_id="BASE123", autostart_relay=False)
    assert base.run_id == "BASE123"          # probe pinned to the batch's base id
    assert base.baseline_run_id is None       # the base is top-level

    child = Session(name="rerun ablate=planner", baseline_run_id="BASE123", autostart_relay=False)
    assert child.baseline_run_id == "BASE123" # a re-run nests under the base
    assert child.run_id != "BASE123"          # but has its own id


def test_session_start_event_emits_baseline_run_id():
    ev = serialize(SessionStartEvent(name="rerun ablate=planner", source="sdk", baseline_run_id="BASE123"))
    assert ev["kind"] == "session_start"
    assert ev["baseline_run_id"] == "BASE123"
    # a normal run leaves it null (top-level in Logs)
    assert serialize(SessionStartEvent(name="run", source="sdk"))["baseline_run_id"] is None
