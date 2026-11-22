/** Words for fields an import owns while its schedule is on (docs/import-field-locks-plan.md). */
export const lockMessage = (connection) =>
  `Managed by ${connection || "an import"}. It updates this field on a schedule, so a change made here would be overwritten. To edit it in Fortress, switch the field to “Fortress wins” in the import template, or switch the schedule off.`;

/** The reason a refused save gives, from the 409 `field_managed_by_import` (details: { fields, connection }). */
export const isLockedByImport = (error) => error?.code === "field_managed_by_import" || error?.body?.error?.code === "field_managed_by_import";

/** A form's own name for a field → the import catalogue's key for it (`siteId` → `site`, `unitCode` → `unit`); names that already match stay as they are. */
export const lockKey = (name) => name.replace(/(Id|Code)$/, "");

/** The kinds of record the database guards (the same eight tables as `app.integration_lock_table`). */
export const LOCKABLE_KINDS = ["supplier", "customer", "part", "machine", "employee", "gauge_type", "gauge", "production_order"];
/** Catalogue fields that fill another table (a part's revision): the guard does not cover them, so they are never locked. Custom fields (`cf_<key>`) are covered by `app.set_custom_values`. */
const NOT_GUARDED = { part: ["revision"] };

/**
 * The fields of a record that a scheduled import with this template version would own: mapped as "source wins" (not Fortress wins, not review), the version
 * updates records, and the field is one the database guards. The lock itself is worked out by the database; this is what the Schedule card tells people.
 */
export const fieldsOwnedBySource = (entityType, version) => {
  if (!LOCKABLE_KINDS.includes(entityType) || !["add_update", "update_only"].includes(version?.settings?.writeMode)) return [];
  const skip = NOT_GUARDED[entityType] ?? [];
  return (version.fields ?? [])
    .filter((f) => f.target && !skip.includes(f.target) && !["qms_wins", "manual_review"].includes(f.ownership))
    .map((f) => f.target);
};
