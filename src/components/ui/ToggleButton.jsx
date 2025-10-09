import { forwardRef } from "react";
import { MdErrorOutline } from "react-icons/md";

const ToggleButton = forwardRef(
  (
    {
      label,
      icon: Icon,
      error,
      checked = false,
      onChange,
      trueLabel = "On",
      falseLabel = "Off",
    },
    ref
  ) => {
    return (
      <div className="flex flex-col min-w-0 w-full">
        {label && (
          <label className="block text-lg font-semibold text-primary-text">
            {label}
          </label>
        )}
        <div
          className={`flex items-center border rounded-lg px-2 py-2 min-w-0 relative
            ${
              error
                ? "border-error-color hover:border-error-color/70 focus-within:border-error-color focus-within:ring-3 focus-within:ring-error-color/20"
                : "border-border-color hover:border-border-dark-color focus-within:border-brand-primary focus-within:hover:border-brand-primary"
            }
            bg-text-input-color focus-within:outline-none focus-within:ring-1 transition`}>
          {error ? (
            <MdErrorOutline
              title={error.message}
              className="w-5 h-5 text-error-color mr-2 flex-shrink-0"
            />
          ) : (
            Icon && (
              <Icon className="w-5 h-5 text-primary-text mr-2 flex-shrink-0 pointer-events-none" />
            )
          )}
          <span className="text-primary-text ml-2 min-w-[60px]">
            {checked ? trueLabel : falseLabel}
          </span>
          <div className="flex flex-1 items-center justify-end">
            <button
              ref={ref}
              type="button"
              onClick={() => onChange(!checked)}
              className={`relative inline-flex items-center h-6 w-11 transition-colors duration-300 ease-in-out cursor-pointer rounded-full
              ${checked ? "bg-brand-primary" : "bg-border-color"}`}>
              <span
                className={`inline-block w-5 h-5 transform bg-white rounded-full shadow-md transition-transform duration-300 ease-in-out
                ${checked ? "translate-x-5" : "translate-x-1"}`}
              />
            </button>
          </div>
        </div>
      </div>
    );
  }
);

export default ToggleButton;
