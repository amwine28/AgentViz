import { useState } from "react";
import type { TabMeta } from "../multiStore";

const DOT: Record<TabMeta["status"], string> = {
  running: "var(--c-run)",
  error: "var(--c-err)",
  complete: "var(--c-done)",
  idle: "var(--ink-faint)",
};

// Chrome-style tabs, one per registered terminal session. Tabs are BORN from
// sessions connecting (there's no "+", since a tab maps to a real terminal that
// opted in) — you can select, rename (double-click), and dismiss them.
export function TabStrip({
  tabs,
  onSelect,
  onClose,
  onRename,
}: {
  tabs: TabMeta[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (tabs.length === 0) {
    return (
      <div className="tab-strip">
        <span className="tab-empty">No sessions — run the AgentViz command in a terminal to open a tab.</span>
      </div>
    );
  }

  return (
    <div className="tab-strip" role="tablist">
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.active}
          className={`tab ${t.active ? "active" : ""}`}
          onClick={() => onSelect(t.id)}
          onDoubleClick={() => { setEditing(t.id); setDraft(t.label); }}
          title={`${t.label} — ${t.agents} agent(s), ${t.eventCount} events`}
        >
          <span className="tab-dot" style={{ background: DOT[t.status] }} />
          {editing === t.id ? (
            <input
              className="tab-rename"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => { onRename(t.id, draft.trim() || t.label); setEditing(null); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { onRename(t.id, draft.trim() || t.label); setEditing(null); }
                if (e.key === "Escape") setEditing(null);
              }}
            />
          ) : (
            <span className="tab-label">{t.label}</span>
          )}
          <button
            className="tab-close"
            aria-label="Close tab"
            onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
          >×</button>
        </div>
      ))}
    </div>
  );
}
