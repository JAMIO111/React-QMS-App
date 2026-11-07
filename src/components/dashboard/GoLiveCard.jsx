import { Link } from "react-router-dom";
import { CheckIcon } from "@/components/icons";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { useOrganisationAccess, usePermissions } from "../../hooks/useQmsApi";
import { useGoLiveChecklist } from "../../hooks/useOnboarding";
import { GO_LIVE_ITEMS } from "../../lib/goLive";

/**
 * After the set-up wizard is finished: what is still missing before the organisation is really in use. Required items keep the card here; recommended ones are
 * listed under them. It goes away once every required item is done.
 */
const GoLiveCard = () => {
  const { organisation } = useOrganisation();
  const { onboarding } = useOrganisationAccess();
  const { can } = usePermissions();
  const show = onboarding === "complete" && can("organisation.manage");
  const { data } = useGoLiveChecklist({ enabled: show });
  if (!show || !data || data.requiredDone) return null;

  const items = data.items.map((i) => ({ ...i, ...GO_LIVE_ITEMS[i.key] }));
  const required = items.filter((i) => i.required);
  const recommended = items.filter((i) => !i.required);
  const left = required.filter((i) => !i.done).length;

  const List = ({ list, label }) => (
    <ul aria-label={label} className="flex flex-col gap-1.5 text-sm">
      {list.map((i) => (
        <li key={i.key}>
          <Link to={i.link} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-white/10">
            <span
              aria-hidden="true"
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${i.done ? "border-white bg-white text-gray-900" : "border-white/60"}`}>
              {i.done ? <CheckIcon className="h-3 w-3" /> : null}
            </span>
            <span className={i.done ? "text-white/70 line-through" : "font-medium"}>{i.label}</span>
            <span className="sr-only">{i.done ? " (done)" : " (to do)"}</span>
          </Link>
        </li>
      ))}
    </ul>
  );

  return (
    <section aria-label="Go-live checklist" className="flex flex-col gap-3 rounded-2xl border border-theme-light bg-theme-dark p-5 text-white shadow-sm">
      <div>
        <h2 className="text-lg font-semibold">Get {organisation?.name ?? "your organisation"} ready to use</h2>
        <p className="text-sm text-white/80">
          {left} of {required.length} essentials still to do. Recommended extras are below.
        </p>
      </div>
      <List list={required} label="Essentials" />
      <h3 className="text-xs font-semibold uppercase tracking-wide text-white/70">Recommended</h3>
      <List list={recommended} label="Recommended" />
    </section>
  );
};

export default GoLiveCard;
