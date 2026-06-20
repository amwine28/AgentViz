import { WebSocket } from "ws";
import { SessionBuffer } from "./buffer";

/** One live session's relay-side state (distinct from the browser store's per-session world). */
export interface SessionState {
  sessionId: string;
  name: string;
  buffer: SessionBuffer;
  sdkSockets: Set<WebSocket>;
  startedAt: number;
  lastSeenAt: number;
  closed: boolean;
}

/**
 * Replaces the single global SessionBuffer: one buffer per session id, so a
 * second session's `session_start` can no longer wipe the first. Events with no
 * session_id are routed to a shared "_legacy" session (demos, replays, old SDKs).
 */
export class SessionRegistry {
  private sessions = new Map<string, SessionState>();

  /** Get or lazily create the session for `id`; `name` (from session_start) sets/updates the label. */
  ensure(id: string, name?: string): { state: SessionState; isNew: boolean } {
    let state = this.sessions.get(id);
    const isNew = !state;
    if (!state) {
      state = {
        sessionId: id,
        name: name ?? id,
        buffer: new SessionBuffer(),
        sdkSockets: new Set<WebSocket>(),
        startedAt: Date.now(),
        lastSeenAt: Date.now(),
        closed: false,
      };
      this.sessions.set(id, state);
    }
    if (name && state.name !== name) state.name = name;
    state.lastSeenAt = Date.now();
    state.closed = false;
    return { state, isNew };
  }

  get(id: string): SessionState | undefined {
    return this.sessions.get(id);
  }

  all(): SessionState[] {
    return [...this.sessions.values()];
  }

  /** Remove a closed SDK socket from every session it owned; mark a session closed when its last socket goes. */
  detachSocket(ws: WebSocket): SessionState[] {
    const affected: SessionState[] = [];
    for (const s of this.sessions.values()) {
      if (s.sdkSockets.delete(ws)) {
        affected.push(s);
        if (s.sdkSockets.size === 0) s.closed = true;
      }
    }
    return affected;
  }
}
