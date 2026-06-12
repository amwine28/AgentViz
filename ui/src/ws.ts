import type { AgentVizEvent } from "./types";

type Dispatch = (action: { type: string; [key: string]: unknown }) => void;

const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 5000;

/** WebSocket connection that survives relay restarts: reconnects with
 * exponential backoff so a relay blip during a demo recovers on its own. */
export function createWsConnection(port: number, dispatch: Dispatch): { send: (cmd: object) => string; cleanup: () => void } {
  let ws: WebSocket | null = null;
  let retryMs = INITIAL_RETRY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function connect(): void {
    if (closed) return;
    ws = new WebSocket(`ws://localhost:${port}`);

    ws.onopen = () => {
      retryMs = INITIAL_RETRY_MS;
      dispatch({ type: "connected", value: true });
    };

    ws.onclose = () => {
      dispatch({ type: "connected", value: false });
      if (!closed) {
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      }
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data as string);
        if (Array.isArray(data)) {
          dispatch({ type: "batch_events", events: data as AgentVizEvent[] });
        } else if (data && typeof data.kind === "string") {
          dispatch({ type: "event", event: data as AgentVizEvent });
        }
      } catch { /* ignore malformed */ }
    };
  }

  connect();

  /** Send a command; stamps and returns a cmd_id so the UI can track the ack. */
  function send(cmd: object): string {
    const cmdId = crypto.randomUUID();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ...cmd, cmd_id: cmdId }));
    }
    return cmdId;
  }

  // Expose on window for convenience (e.g., browser console commands)
  (window as Window & { agentVizSend?: typeof send }).agentVizSend = send;

  function cleanup(): void {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    ws?.close();
    delete (window as Window & { agentVizSend?: typeof send }).agentVizSend;
  }

  return { send, cleanup };
}
