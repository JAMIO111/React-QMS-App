import MenuCard from "../../ui/MenuCard";
import { ROOT_CAUSE_KINDS } from "../../../lib/capa";
import ActionList from "../ActionList";

/** D5: a permanent corrective action for every occurrence cause (and for the others where it makes sense). */
const D5Corrective = ({ capa, editable }) => {
  const corrective = capa.actions.filter((a) => a.phase === "corrective" && a.status !== "cancelled");
  return (
    <div className="flex flex-col gap-4">
      <MenuCard title="Root causes and their actions" subtitle="Each cause from D4 and the corrective actions that remove it">
        {capa.rootCauses.length === 0 ? (
          <p className="text-sm text-secondary-text">No root cause yet. Record the causes in D4 first, then plan an action for each.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-color" aria-label="Root causes">
            {capa.rootCauses.map((c) => {
              const n = corrective.filter((a) => a.rootCauseId === c.id).length;
              return (
                <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
                  <p className="max-w-2xl text-primary-text"><span className={`mr-2 rounded-full px-2 py-0.5 text-xs font-medium ${ROOT_CAUSE_KINDS[c.kind].tone}`}>{ROOT_CAUSE_KINDS[c.kind].label}</span>{c.description}</p>
                  <span className={`text-xs ${n === 0 && c.kind === "occurrence" ? "font-medium text-warning-color" : "text-secondary-text"}`}>{n === 0 ? "No corrective action" : `${n} corrective ${n === 1 ? "action" : "actions"}`}</span>
                </li>
              );
            })}
          </ul>
        )}
      </MenuCard>
      <ActionList capa={capa} phase="corrective" editable={editable} withCause title="Corrective actions" addLabel="Add corrective action"
        emptyText="No corrective action yet. Plan a permanent fix for each root cause, with an owner and a due date." />
    </div>
  );
};

export default D5Corrective;
