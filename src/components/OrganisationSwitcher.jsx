import { useOrganisation } from "../contexts/OrganisationProvider";

/** Lets members of several organisations choose which one they are working in. */
const OrganisationSwitcher = () => {
  const { organisations, organisationId, selectOrganisation } = useOrganisation();
  if (organisations.length < 2) return null;
  return (
    <label className="flex items-center gap-2 text-sm text-secondary-text">
      <span className="sr-only">Organisation</span>
      <select
        aria-label="Organisation"
        value={organisationId ?? ""}
        onChange={(e) => selectOrganisation(e.target.value)}
        className="max-w-56 truncate rounded-lg border border-border-color bg-primary-bg px-2 py-1.5 text-primary-text cursor-pointer">
        {organisations.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
};

export default OrganisationSwitcher;
