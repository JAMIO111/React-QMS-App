import { useId } from "react";

/** Labelled input styled like the app's other form controls; extra props go to the <input>. */
const Field = ({ label, hint, error, className = "", inputClassName = "", ...inputProps }) => {
  const id = useId();
  return (
    <div className={`flex flex-col gap-1 min-w-0 ${className}`}>
      <label htmlFor={id} className="text-sm font-medium text-primary-text">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? `${id}-help` : undefined}
        className={`rounded-lg border px-3 py-2 bg-text-input-color text-primary-text shadow-s focus:outline-none focus:border-brand-primary disabled:opacity-60 ${
          error ? "border-error-color" : "border-border-color"
        } ${inputClassName}`}
        {...inputProps}
      />
      {(error || hint) && (
        <p id={`${id}-help`} className={`text-xs ${error ? "text-error-color" : "text-secondary-text"}`}>
          {error || hint}
        </p>
      )}
    </div>
  );
};

export default Field;
