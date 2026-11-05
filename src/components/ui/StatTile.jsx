/** Small summary figure for the top of a settings page: label, big number and a note. */
const StatTile = ({ label, value, note }) => (
  <div className="flex min-w-40 flex-1 flex-col rounded-2xl border border-border-color bg-secondary-bg px-5 py-3">
    <span className="text-xs uppercase tracking-wide text-tertiary-text">{label}</span>
    <span className="text-2xl font-semibold text-primary-text">{value}</span>
    {note && <span className="text-xs text-secondary-text">{note}</span>}
  </div>
);

export default StatTile;
