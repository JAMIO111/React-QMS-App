import { Link } from "react-router-dom";
import { CircleAlertIcon, CircleCheckIcon } from "@/components/icons";
import { describeRequirement, describeSampling, describeSpc } from "../../lib/processControl";

const th = "border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text";
const td = "border-b border-border-color px-2 py-2 align-top";

/**
 * The outcome of resolving a part against its control plan: which plan revision and part revision
 * apply and the requirements an operator would get — or, when blocked, every reason in words.
 * Not-applicable characteristics are listed with the rule that excludes them (never hidden).
 */
const ResolutionView = ({ resolution: r, showPlanLink = true }) => {
  const blocked = r.status === "blocked";
  const applicable = r.requirements.filter((q) => q.applicable).length;
  return (
    <div className="flex flex-col gap-3">
      <div
        role="status"
        className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${blocked ? "border-error-color/40 bg-error-color/10" : "border-success-color/40 bg-success-color/10"}`}>
        {blocked ? <CircleAlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-error-color" /> : <CircleCheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-success-color" />}
        <div className="flex flex-col gap-1 text-primary-text">
          <strong>{blocked ? "An inspection could not start" : "Ready for inspection"}</strong>
          <span>
            {r.part.partNumber}
            {r.partRevision ? ` revision ${r.partRevision.revision}` : ""}
            {r.plan && (
              <>
                {" · "}
                {showPlanLink ? (
                  <Link to={`/Process-Control/Plans/${r.plan.id}`} className="text-link-color hover:underline">
                    {r.plan.planCode}
                  </Link>
                ) : (
                  r.plan.planCode
                )}
                {r.planRevision ? ` revision ${r.planRevision.revisionCode}` : ""}
              </>
            )}
            {r.operationCode ? ` · ${r.operationCode}` : ""}
            {!blocked && ` · ${applicable} check${applicable === 1 ? "" : "s"}`}
          </span>
          {!blocked && r.scopeLevel === "part" && (
            <span className="text-xs text-secondary-text">
              Plan for this part
              {r.overriddenPlans?.length ? `; overrides the family plan${r.overriddenPlans.length > 1 ? "s" : ""} ${r.overriddenPlans.map((p) => p.planCode).join(", ")}` : ""}
            </span>
          )}
          {blocked && (
            <ul className="list-disc pl-5">
              {r.problems.map((p, i) => (
                <li key={i}>{p.message}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {r.requirements.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-separate border-spacing-0 text-sm text-primary-text" aria-label={`Requirements for ${r.part.partNumber}`}>
            <thead>
              <tr>
                <th scope="col" className={th}>Operation</th>
                <th scope="col" className={th}>Characteristic</th>
                <th scope="col" className={th}>Requirement</th>
                <th scope="col" className={th}>Method / gauge</th>
                <th scope="col" className={th}>Sampling</th>
                <th scope="col" className={th}>SPC</th>
              </tr>
            </thead>
            <tbody>
              {r.requirements.map((q) => (
                <tr key={q.planCharacteristicId} className={q.applicable ? "" : "text-secondary-text"}>
                  <td className={`${td} font-mono`}>{q.operationCode}</td>
                  <td className={td}>
                    <div className="font-medium">
                      {q.charNumber && <span className="mr-1 text-secondary-text">#{q.charNumber}</span>}
                      {q.name}
                    </div>
                    <div className="text-xs text-secondary-text">
                      <span className="font-mono">{q.characteristicKey}</span> · {q.applicable ? q.applicability : `Not applicable: ${q.applicability}`}
                    </div>
                  </td>
                  <td className={`${td} tabular-nums`}>
                    {!q.applicable ? (
                      "—"
                    ) : !q.resolved ? (
                      <span className="text-error-color">Missing part value {q.specKey}</span>
                    ) : (
                      <>
                        {describeRequirement({ ...q, valueSource: "plan" })}
                        {q.valueSource === "part_spec" && <div className="text-xs text-secondary-text">from part value {q.specKey}</div>}
                      </>
                    )}
                  </td>
                  <td className={td}>
                    {q.method ?? "—"}
                    {q.gaugeType && <div className="text-xs text-secondary-text">{q.gaugeType.name}</div>}
                  </td>
                  <td className={td}>{q.sampling.length ? q.sampling.map((s, i) => <div key={i}>{describeSampling(s)}</div>) : "On demand"}</td>
                  <td className={td}>{describeSpc(q) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default ResolutionView;
