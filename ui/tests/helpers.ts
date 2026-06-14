import { reducer, initialState } from "../src/store";
import type { AppState } from "../src/store";
import type { AgentVizEvent } from "../src/types";

/** Replay an event list through the reducer to an AppState — the shared
 * test-fixture builder (was copy-pasted in audit.test.ts / graph.test.ts). */
export function play(events: object[]): AppState {
  return (events as AgentVizEvent[]).reduce(
    (s, event) => reducer(s, { type: "event", event }),
    initialState
  );
}
