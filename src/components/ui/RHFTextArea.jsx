import { forwardRef, useId } from "react";
import { CircleAlertIcon, XIcon } from "@/components/icons";

const RHFTextAreaInput = forwardRef(
  (
    {
      value,
      onChange,
      placeholder = "Enter text...",
      label,
      icon: Icon,
      rows = 5,
      max = 1000,
      error,
      required = false,
      disabled = false,
      hint,
      name,
      onBlur,
    },
    ref
  ) => {
    const id = useId();
    const errorMessage = typeof error === "string" ? error : error?.message;
    return (
      <div className="w-full min-w-0">
        {label && (
          <label htmlFor={id} className="block mb-1 text-sm font-medium text-secondary-text" data-required={required || undefined}>
            {label}
            </label>
        )}
        {/* Same frame as TextInput: border, darker on hover, brand border + soft ring when focused. */}
        <div
          className={`relative flex rounded-lg border bg-text-input-color px-2 py-2 transition-all duration-150 ${
            error
              ? "border-error-color hover:border-error-color focus-within:border-error-color focus-within:ring-3 focus-within:ring-error-color/20"
              : "border-border-color hover:border-border-dark-color focus-within:border-brand-primary focus-within:ring-3 focus-within:ring-brand-primary/20"
          } ${disabled ? "opacity-60 hover:border-border-color" : ""}`}>
          {error ? (
            <CircleAlertIcon
              title={errorMessage}
              className="w-5 h-5 text-error-color mr-3 flex-shrink-0"
            />
          ) : (
            Icon && <Icon className="w-5 h-5 text-primary-text mr-3 flex-shrink-0 pointer-events-none" />
          )}

          <textarea
            maxLength={max}
            ref={ref}
            id={id}
            name={name}
            onBlur={onBlur}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={errorMessage || hint ? `${id}-help` : undefined}
            value={value ?? ""}
            onChange={onChange}
            placeholder={placeholder}
            rows={rows}
            className="flex-grow w-full bg-transparent outline-none text-primary-text placeholder:text-sm placeholder:text-muted resize-none pr-6 disabled:cursor-not-allowed"
          />

          {value && !disabled && (
            <button
              type="button"
              onClick={() => onChange({ target: { value: "" } })}
              className="absolute top-2 right-2 text-primary-text hover:bg-border-color rounded-sm p-0.5"
              aria-label={label ? `Clear ${label}` : "Clear"}>
              <XIcon className="w-5 h-5" />
            </button>
          )}
        </div>
        {(errorMessage || hint) && (
          <p id={`${id}-help`} className={`mt-1 text-xs ${errorMessage ? "text-error-color" : "text-secondary-text"}`}>
            {errorMessage || hint}
          </p>
        )}
      </div>
    );
  }
);

export default RHFTextAreaInput;
