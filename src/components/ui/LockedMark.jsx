import { LockIcon } from "@/components/icons";
import { lockMessage } from "../../lib/importLocks";
import Tooltip from "./Tooltip";

/** A small lock beside a label for a field an import manages; hover or focus it to read why the field is locked. */
const LockedMark = ({ by }) => (
  <Tooltip content={lockMessage(by)}>
    <button type="button" aria-label={`Managed by ${by || "an import"}`} className="ml-1.5 inline-flex cursor-help items-center align-middle text-secondary-text hover:text-primary-text focus-visible:outline-2 focus-visible:outline-brand-primary" onClick={(e) => e.preventDefault()}>
      <LockIcon className="h-3.5 w-3.5" />
    </button>
  </Tooltip>
);

export default LockedMark;
