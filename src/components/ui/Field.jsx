import { useId } from "react";

/** Labelled input styled like the app's other form controls; extra props go to the <input>. */
const Field = ({ label, hint, error, className = "", inputClassName = "", required, ...inputProps }) => {
  const id = useId();
  return (
    <div className={`flex flex-col gap-1 min-w-0 ${className}`}>
      <label htmlFor={id} className="text-sm font-medium text-secondary-text" data-required={required || undefined}>
        {label}
      </label>
      <input
        id={id}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? `${id}-help` : undefined}
        className={`rounded-lg border px-3 py-2 bg-text-input-color text-sm text-primary-text outline-none transition-all duration-150 placeholder:text-sm placeholder:text-muted disabled:opacity-60 ${
          error ? "border-error-color focus:ring-3 focus:ring-error-color/20" : "border-border-color hover:border-border-dark-color focus:border-brand-primary focus:ring-3 focus:ring-brand-primary/20"
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
