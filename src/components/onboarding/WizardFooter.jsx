import { Link } from "react-router-dom";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";

/**
 * Under every step: Back, and the ways forward. `mark` steps (details, security, team) offer "Skip for now" and "Done, continue"; the others just continue.
 * `blocked` explains why continuing is not possible yet (shown, never a dead end).
 */
const WizardFooter = ({ prev, onBack, onSkip, onContinue, continueLabel = "Continue", canSkip = false, pending = false, blocked = null }) => (
  <div className="flex flex-col gap-3 border-t border-border-color pt-4">
    {blocked && <Callout tone="info" role="status">{blocked}</Callout>}
    <div className="flex flex-wrap items-center justify-between gap-2">
      {prev ? (
        <CTAButton to={`/setup/${prev.key}`} onClick={onBack} type="neutral" size="md" className="inline-flex items-center gap-1">
          <ChevronLeftIcon className="h-4 w-4" /> {prev.label}
        </CTAButton>
      ) : (
        <span />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {canSkip && (
          <CTAButton buttonType="button" type="neutral" size="md" disabled={pending} loading={pending} onClick={onSkip}>
            Skip for now
          </CTAButton>
        )}
        <CTAButton buttonType="button" type="main" size="lg" className="inline-flex items-center gap-1" disabled={pending || !!blocked} loading={pending} onClick={onContinue}>
          {pending ? "Saving…" : continueLabel} <ChevronRightIcon className="h-4 w-4" />
        </CTAButton>
      </div>
    </div>
  </div>
);

export default WizardFooter;
