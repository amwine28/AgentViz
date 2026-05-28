import type { AgentVizEvent } from "./types";

type Dispatch = (action: { type: string; [key: string]: unknown }) => void;

export function createWsConnection(port: number, dispatch: Dispatch): () => void {
  const ws = new WebSocket(`ws://localhost:${port}`);

  ws.onopen = () => dispatch({ type: "connected", value: true });
  ws.onclose = () => dispatch({ type: "connected", value: false });

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data as string);
      if (Array.isArray(data)) {
        dispatch({ type: "batch_events", events: data as AgentVizEvent[] });
      } else {
        dispatch({ type: "event", event: data as AgentVizEvent });
      }
    } catch { /* ignore */ }
  };

  function sendCommand(cmd: object): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(cmd));
    }
  }

  (window as Window & { agentVizSend?: typeof sendCommand }).agentVizSend = sendCommand;

  return () => ws.close();
}
