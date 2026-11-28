import { useOrganisation } from "../contexts/OrganisationProvider";
import { useBlockedOrganisations } from "../hooks/useSecurity";

/** Lets members of several organisations choose which one they are working in. */
const OrganisationSwitcher = ({ className = "", selectClassName = "" }) => {
  const { organisations, organisationId, selectOrganisation } = useOrganisation();
  const blocked = useBlockedOrganisations();
  if (organisations.length < 2) return null;
  return (
    <label className={`flex items-center gap-2 text-sm text-secondary-text ${className}`}>
      <span className="sr-only">Organisation</span>
      <select
        aria-label="Organisation"
        value={organisationId ?? ""}
        onChange={(e) => selectOrganisation(e.target.value)}
        className={`max-w-56 truncate rounded-lg border border-border-color bg-primary-bg h-9.5 px-2 py-1.5 text-sm text-primary-text cursor-pointer ${selectClassName}`}>
        {organisations.map((o) => (
          <option key={o.id} value={o.id}>
            {blocked.has(o.id) ? `${o.name} (not available on this network)` : o.name}
          </option>
        ))}
      </select>
    </label>
  );
};

export default OrganisationSwitcher;
