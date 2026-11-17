import { useRef } from "react";
import { withVersion } from "../lib/editConflicts";

/**
 * The version of a record an edit started from (docs/edit-conflicts-plan.md EC3). While nothing is changed it follows the record as it refetches;
 * once the person starts changing something it stays on the version they were looking at, so a save made after someone else's change (which a
 * refetch may already have brought in underneath the open form) is still caught. Returns `versioned(body)`, the body with that version added.
 */
export const useEditBase = (record, dirty) => {
  const base = useRef(null);
  if (!dirty || !base.current || base.current.id !== record?.id) base.current = record ? { id: record.id, rowVersion: record.rowVersion } : null;
  return (body) => withVersion(base.current, body);
};
