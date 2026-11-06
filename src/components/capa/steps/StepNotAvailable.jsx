/** Steps D2 to D8 arrive in the next slices (docs/capa-8d-plan.md §8). */
const StepNotAvailable = ({ step }) => (
  <p className="rounded-lg border border-dashed border-border-dark-color bg-secondary-bg p-4 text-sm text-secondary-text">
    {step.code} · {step.title} is not available yet. It is being built next; D0 and D1 can be completed now.
  </p>
);
export default StepNotAvailable;
