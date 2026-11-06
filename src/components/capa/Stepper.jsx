import { Link } from "react-router-dom";
import { CheckIcon } from "@/components/icons";
import { STEPS } from "../../lib/capa";

/**
 * The eight disciplines (and D0) as a vertical rail, or a row on a narrow screen. Done steps carry a tick, the step on screen is marked
 * with aria-current, and the first step not yet complete is the one the 8D is "at". Every step can be opened; completing is in order.
 */
const Stepper = ({ capa, active }) => {
  const done = new Map(capa.steps.map((s) => [s.step, s.completed]));
  return (
    <nav aria-label="8D steps" className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
      {STEPS.map((s) => {
        const isDone = done.get(s.key);
        const isCurrent = s.key === capa.currentStep && capa.stage !== "closed" && capa.stage !== "cancelled";
        const isActive = s.key === active;
        return (
          <Link
            key={s.key}
            to={`/CAPA/${capa.id}/${s.key}`}
            aria-current={isActive ? "step" : undefined}
            className={`flex min-w-[8.5rem] items-center gap-3 rounded-xl border px-3 py-2 text-sm lg:min-w-0 ${
              isActive ? "border-brand-primary bg-brand-primary/10 text-primary-text" : "border-transparent text-secondary-text hover:bg-secondary-bg"
            }`}>
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                isDone ? "bg-success-color text-white" : isCurrent ? "border-2 border-brand-primary text-primary-text" : "border border-border-color text-secondary-text"
              }`}>
              {isDone ? <CheckIcon className="h-4 w-4" aria-label="Complete" /> : s.code}
            </span>
            <span className="flex min-w-0 flex-col leading-tight">
              <span className={`truncate ${isActive ? "font-medium" : ""}`}>{s.label}</span>
              <span className="text-xs text-secondary-text">{isDone ? "Complete" : isCurrent ? "In progress" : s.code}</span>
            </span>
          </Link>
        );
      })}
    </nav>
  );
};

export default Stepper;
