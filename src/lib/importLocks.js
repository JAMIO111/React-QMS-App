/** Words for fields an import owns while its schedule is on (docs/import-field-locks-plan.md). */
export const lockMessage = (connection) =>
  `Managed by ${connection || "an import"}. It updates this field on a schedule, so a change made here would be overwritten. To edit it in Fortress, switch the field to “Fortress wins” in the import template, or switch the schedule off.`;

/** The reason a refused save gives, from the 409 `field_managed_by_import` (details: { fields, connection }). */
export const isLockedByImport = (error) => error?.code === "field_managed_by_import" || error?.body?.error?.code === "field_managed_by_import";

/** A form's own name for a field → the import catalogue's key for it (`siteId` → `site`, `unitCode` → `unit`); names that already match stay as they are. */
export const lockKey = (name) => name.replace(/(Id|Code)$/, "");
