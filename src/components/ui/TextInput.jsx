import { HiMiniXMark } from "react-icons/hi2";
import { forwardRef } from "react";
import { MdErrorOutline } from "react-icons/md";

const TextInput = forwardRef(
  (
    {
      dataType = "text",
      required = false,
      value = "",
      onChange,
      placeholder = "Enter text...",
      label,
      icon: Icon,
      error,
      prefix,
      suffix,
      textTransform = "none", // ⬅️ new prop
      ...rest
    },
    ref
  ) => {
    const handleKeyDownNumeric = (e) => {
      if (
        [
          "Backspace",
          "Tab",
          "ArrowLeft",
          "ArrowRight",
          "Delete",
          "Home",
          "End",
        ].includes(e.key) ||
        (e.key >= "0" && e.key <= "9") ||
        e.key === "."
      ) {
        return;
      } else {
        e.preventDefault();
      }
    };

    return (
      <div className="flex flex-col gap-1 h-17 min-w-0">
        {label && (
          <div className="flex items-center gap-1">
            <label className="block font-medium text-primary-text">
              {label}
            </label>
            {required && (
              <label className="text-error-color text-sm" title="Required">
                *
              </label>
            )}
          </div>
        )}
        <div
          className={`flex border flex-row relative items-center shadow-s hover:shadow-m rounded-lg pl-2 pr-10 py-2 bg-text-input-color
             focus-within:border-brand-primary focus-within:hover:border-brand-primary min-w-0
            ${
              error
                ? "border border-error-color hover:border-error-color/70 hover:focus-within:border-error-color focus-within:border-error-color focus-within:ring-3 focus-within:ring-error-color/20"
                : "border-transparent"
            }`}>
          {error ? (
            <MdErrorOutline
              title={error.message}
              className="w-5 h-5 text-error-color mr-3 flex-shrink-0"
            />
          ) : (
            Icon && (
              <Icon className="w-5 h-5 text-primary-text mr-3 flex-shrink-0 pointer-events-none" />
            )
          )}

          {prefix && (
            <span className="absolute left-10 text-primary-text pointer-events-none">
              {prefix}
            </span>
          )}

          <input
            onKeyDown={dataType === "number" ? handleKeyDownNumeric : undefined}
            ref={ref}
            type={dataType}
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            className={`placeholder:normal-case input-no-arrows flex-grow w-full min-w-0 bg-transparent outline-none text-primary-text placeholder:text-sm placeholder:text-muted
              ${prefix ? "pl-5" : ""}
              ${suffix ? "pr-4 text-right" : ""}
              ${textTransform !== "none" ? `capitalize-${textTransform}` : ""}
            `}
            style={{
              textTransform: textTransform, // apply css transform
            }}
            {...rest}
          />

          {suffix && (
            <span className="absolute right-10 text-primary-text pointer-events-none">
              {suffix}
            </span>
          )}

          {value !== "" && (
            <button
              type="button"
              onClick={() => onChange({ target: { value: undefined } })} // ⬅️ fixed from undefined
              className="absolute right-2 text-primary-text hover:bg-secondary-bg rounded-sm p-0.5"
              aria-label="Clear">
              <HiMiniXMark className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>
    );
  }
);

export default TextInput;
