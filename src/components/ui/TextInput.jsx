import { CircleAlertIcon, XIcon } from "@/components/icons";
import { forwardRef, useEffect, useId, useRef, useState } from "react";

const TextInput = forwardRef(
  (
    {
      dataType = "text",
      required = false,
      value,
      defaultValue,
      onChange,
      placeholder = "Enter text...",
      label,
      icon: Icon,
      error,
      prefix,
      suffix,
      textTransform = "none", // ⬅️ new prop
      hint,
      id: idProp,
      ...rest
    },
    ref,
  ) => {
    // Controlled when the page handles changes; otherwise the box keeps its own value (starting
    // from value/defaultValue), so it can always be typed in and cleared.
    const controlled = value !== undefined && typeof onChange === "function";
    const [ownValue, setOwnValue] = useState(value ?? defaultValue ?? "");
    useEffect(() => {
      if (!controlled && value !== undefined) setOwnValue(value ?? "");
    }, [controlled, value]);
    const current = (controlled ? value : ownValue) ?? "";

    const autoId = useId();
    const id = idProp ?? autoId;
    const errorMessage = typeof error === "string" ? error : error?.message;
    const inputRef = useRef(null);
    const setRefs = (el) => {
      inputRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    };

    const handleChange = (e) => {
      if (!controlled) setOwnValue(e.target.value);
      onChange?.(e);
    };

    const clear = () => {
      if (!controlled) setOwnValue("");
      onChange?.({ target: { value: "", name: rest.name } });
      inputRef.current?.focus();
    };

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
      <div className="flex flex-col gap-1 min-h-17 min-w-0">
        {label && (
          <label htmlFor={id} className="block text-sm font-medium text-secondary-text" data-required={required || undefined}>
            {label}
            </label>
        )}
        <div
          className={`group flex border flex-row relative items-center rounded-lg pl-2 pr-10 py-2 bg-text-input-color
  border-border-color
  hover:border-border-dark-color
  focus-within:border-brand-primary
  focus-within:ring-3 focus-within:ring-brand-primary/20
  transition-all duration-150
  min-w-0
  ${rest.disabled ? "opacity-60 hover:border-border-color" : ""}
  ${
    error
      ? "border-error-color hover:border-error-color focus-within:border-error-color focus-within:ring-error-color/20"
      : ""
  }`}>
          {error ? (
            <CircleAlertIcon
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
            ref={setRefs}
            id={id}
            aria-invalid={error ? true : undefined}
            aria-describedby={errorMessage || hint ? `${id}-help` : undefined}
            required={required || undefined}
            type={dataType}
            value={current}
            onChange={handleChange}
            placeholder={placeholder}
            className={`placeholder:normal-case input-no-arrows flex-grow w-full min-w-0 bg-transparent outline-none text-primary-text placeholder:text-sm placeholder:text-muted disabled:cursor-not-allowed
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

          {String(current) !== "" && !rest.disabled && !rest.readOnly && (
            <button
              type="button"
              onClick={clear}
              className="absolute right-2 text-secondary-text hover:text-primary-text hover:bg-secondary-bg rounded-sm p-0.5 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity duration-150"
              aria-label={label ? `Clear ${label}` : "Clear"}>
              <XIcon className="w-5 h-5" />
            </button>
          )}
        </div>
        {(errorMessage || hint) && (
          <p id={`${id}-help`} className={`text-xs ${errorMessage ? "text-error-color" : "text-secondary-text"}`}>
            {errorMessage || hint}
          </p>
        )}
      </div>
    );
  },
);

export default TextInput;
