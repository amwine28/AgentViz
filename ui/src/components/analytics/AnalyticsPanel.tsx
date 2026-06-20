import type { SessionWorld } from "../../store";
import { GraphStats } from "../GraphStats";
import { CreditView } from "../CreditView";
import { OpsView } from "../OpsView";
import {
  type AnalyticsUi, type SectionId, SECTION_ORDER, SECTION_LABEL,
} from "./analyticsState";

// One dockable, per-tab Analytics panel on the stage's right edge. Consolidates
// the computed insight — graph stats + efficiency audit, credit assignment, and
// operations — into collapsible sections. Minimizes to a thin rail.
export function AnalyticsPanel({
  world,
  ui,
  onSetDock,
  onToggleSection,
  onSelectNode,
}: {
  world: SessionWorld;
  ui: AnalyticsUi;
  onSetDock: (d: "expanded" | "minimized") => void;
  onToggleSection: (s: SectionId) => void;
  onSelectNode: (id: string | null) => void;
}) {
  if (ui.dock === "minimized") {
    return (
      <button
        className="analytics-rail"
        onClick={() => onSetDock("expanded")}
        title="Open analytics"
        aria-label="Open analytics panel"
      >
        <span className="analytics-rail-label">ANALYTICS</span>
      </button>
    );
  }

  return (
    <aside className="analytics-panel panel" aria-label="Analytics">
      <div className="panel-title">
        <span>Analytics</span>
        <button className="panel-close" onClick={() => onSetDock("minimized")} aria-label="Minimize analytics">–</button>
      </div>
      <div className="analytics-body">
        {SECTION_ORDER.map((id) => (
          <section key={id} className="analytics-section">
            <button
              className="analytics-section-head"
              aria-expanded={ui.sections[id]}
              onClick={() => onToggleSection(id)}
            >
              <span className="analytics-caret">{ui.sections[id] ? "▾" : "▸"}</span>
              {SECTION_LABEL[id]}
            </button>
            {ui.sections[id] && (
              <div className="analytics-section-body">
                {id === "graph" && <GraphStats state={world} />}
                {id === "credit" && <CreditView state={world} onSelectNode={onSelectNode} />}
                {id === "ops" && <OpsView operations={world.operations} onSelectNode={onSelectNode} />}
              </div>
            )}
          </section>
        ))}
      </div>
    </aside>
  );
}
