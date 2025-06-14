import { HiMiniXMark } from "react-icons/hi2";
import { forwardRef } from "react";
import { MdErrorOutline } from "react-icons/md";

const TextInput = forwardRef(
  (
    {
      dataType = "text",
      value = "",
      onChange,
      placeholder = "Enter text...",
      label,
      icon: Icon,
      error,
      prefix,
      suffix,
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
      <div className="flex flex-col h-17 min-w-0">
        {label && <label className="block text-primary-text">{label}</label>}
        <div
          className={`flex flex-row relative items-center border border-border-color rounded-lg pl-2 pr-10 py-2 bg-text-input-color
    hover:border-border-dark-color focus-within:border-brand-primary focus-within:hover:border-brand-primary min-w-0
    ${
      error
        ? "border-error-color hover:border-error-color/70 hover:focus-within:border-error-color focus-within:border-error-color focus-within:ring-3 focus-within:ring-error-color/20"
        : ""
    }`}>
          {error ? (
            <MdErrorOutline
              title={error.message}
              className="w-5 h-5 text-error-color mr-2 flex-shrink-0"
            />
          ) : (
            <Icon className="w-5 h-5 text-primary-text mr-2 flex-shrink-0 pointer-events-none" />
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
            className={`input-no-arrows flex-grow w-full min-w-0 bg-transparent outline-none text-primary-text placeholder:text-sm placeholder:text-muted
            ${prefix ? "pl-5" : ""}
            ${suffix ? "pr-4 text-right" : ""}
            `}
          />

          {suffix && (
            <span className="absolute right-10 text-primary-text pointer-events-none">
              {suffix}
            </span>
          )}

          {value !== "" && (
            <button
              type="button"
              onClick={() => onChange({ target: { value: "" } })}
              className="absolute right-2 text-primary-text hover:bg-border-color rounded-sm p-0.5"
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
