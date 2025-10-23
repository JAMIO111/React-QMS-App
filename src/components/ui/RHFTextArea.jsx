import { forwardRef } from "react";
import { HiMiniXMark } from "react-icons/hi2";
import { MdErrorOutline } from "react-icons/md";

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
    },
    ref
  ) => {
    return (
      <div className="w-full">
        {label && (
          <label className="block mb-1 text-primary-text">{label}</label>
        )}
        <div
          className={`shadow-s hover:shadow-m border ${
            error &&
            "border-error-color hover:border-error-color/70 focus-within:border-error-color focus-within:hover:border-error-color focus-within:ring-3 focus-within:ring-error-color/20"
          } relative flex rounded-lg px-2 py-2 bg-text-input-color border-transparent
         focus-within:border-brand-primary focus-within:hover:border-brand-primary`}>
          {error ? (
            <MdErrorOutline
              title={error.message}
              className="w-5 h-5 text-error-color mr-2 flex-shrink-0"
            />
          ) : (
            <Icon className="w-5 h-5 text-primary-text mr-2 flex-shrink-0 pointer-events-none" />
          )}

          <textarea
            maxLength={max}
            ref={ref}
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            rows={rows}
            className="flex-grow w-full bg-transparent outline-none text-primary-text placeholder:text-sm placeholder:text-muted resize-none pr-6"
          />

          {value && (
            <button
              type="button"
              onClick={() => onChange({ target: { value: "" } })}
              className="absolute top-2 right-2 text-primary-text hover:bg-border-color rounded-sm p-0.5"
              aria-label="Clear">
              <HiMiniXMark className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>
    );
  }
);

export default RHFTextAreaInput;
