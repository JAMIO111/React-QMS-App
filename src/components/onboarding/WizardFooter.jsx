import { Link } from "react-router-dom";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";
import { buttonClass } from "../master-data/shared";

/**
 * Under every step: Back, and the ways forward. `mark` steps (details, security, team) offer "Skip for now" and "Done, continue"; the others just continue.
 * `blocked` explains why continuing is not possible yet (shown, never a dead end).
 */
const WizardFooter = ({ prev, onBack, onSkip, onContinue, continueLabel = "Continue", canSkip = false, pending = false, blocked = null }) => (
  <div className="flex flex-col gap-3 border-t border-border-color pt-4">
    {blocked && <p role="status" className="rounded-lg border border-border-color bg-secondary-bg p-3 text-sm text-primary-text">{blocked}</p>}
    <div className="flex flex-wrap items-center justify-between gap-2">
      {prev ? (
        <Link to={`/setup/${prev.key}`} onClick={onBack} className={`${buttonClass.neutral} inline-flex items-center gap-1`}>
          <ChevronLeftIcon className="h-4 w-4" /> {prev.label}
        </Link>
      ) : (
        <span />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {canSkip && (
          <button type="button" className={buttonClass.neutral} disabled={pending} onClick={onSkip}>
            Skip for now
          </button>
        )}
        <button type="button" className={`${buttonClass.primary} inline-flex items-center gap-1`} disabled={pending || !!blocked} onClick={onContinue}>
          {pending ? "Saving…" : continueLabel} <ChevronRightIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  </div>
);

export default WizardFooter;
