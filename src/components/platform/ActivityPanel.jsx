import { usePlatformActivity } from "../../hooks/usePlatform";
import { Card, Panel, Pill } from "./Panels";
import { describeEvent, when } from "./format";

const KINDS = { billing: ["Billing", "info"], organisation: ["Organisation", "good"] };

/** What has been happening across the platform, newest first. */
const ActivityPanel = () => {
  const query = usePlatformActivity(100);
  return (
    <Panel query={query}>
      {(a) => (
        <Card title="Activity" subtitle="Billing events and organisation milestones. Nothing from inside anyone's quality records.">
          {a.data.length === 0 ? (
            <p className="text-sm text-secondary-text">Nothing has happened yet.</p>
          ) : (
            <ol aria-label="Activity" className="flex flex-col">
              {a.data.map((e, i) => {
                const [label, tone] = KINDS[e.kind] ?? [e.kind, "quiet"];
                return (
                  <li key={`${e.at}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border-color py-2 text-sm last:border-0">
                    <span className="w-40 shrink-0 text-xs text-secondary-text">{when(e.at)}</span>
                    <Pill tone={tone}>{label}</Pill>
                    <span className="text-primary-text"><strong>{e.organisation}</strong>: {describeEvent(e)}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>
      )}
    </Panel>
  );
};

export default ActivityPanel;
