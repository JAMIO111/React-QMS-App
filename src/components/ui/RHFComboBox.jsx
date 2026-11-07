import { useState, useRef, useEffect, useId } from "react";
import { ChevronDownIcon, CircleAlertIcon, XIcon } from "@/components/icons";

/**
 * Searchable single-select, controlled by `value` (an option id) and `onChange(id | null)`, so it
 * drops straight into react-hook-form:
 *
 *   <Controller name="failureModeId" control={control}
 *     render={({ field, fieldState }) => <RHFComboBox {...field} error={fieldState.error} label="Failure mode" options={…} />} />
 *
 * Options: [{ id, name, hint?, disabled? }]. `name` is shown and searched; `hint` is a muted second
 * line in the list. Options are sorted by name unless `sort={false}`.
 *
 * Server-side search: pass `onSearchChange(term)` and `filterLocally={false}`; keep the selected
 * option in `options` (or pass `selectedOption`) so its name still shows when it is not in the results.
 *
 * Dependent lists (e.g. sub-failure mode under failure mode): `dependentKey` + `dependentValue`
 * filter options by `option[dependentKey] === dependentValue` and disable the box until it is set.
 */
const RHFComboBox = ({
  value,
  onChange,
  onBlur,
  name,
  ref,
  required = false,
  disabled = false,
  icon: Icon,
  options = [],
  selectedOption: selectedOptionProp,
  placeholder = "Select...",
  label,
  hint,
  emptyMessage = "No results",
  sort = true,
  filterLocally = true,
  onSearchChange,
  clearable = true,
  dependentValue,
  dependentKey,
  dependentPlaceholder,
  secondaryField,
  secondaryFieldOptions,
  error,
  className = "",
}) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const id = useId();
  const listId = `${id}-list`;
  const helpId = `${id}-help`;
  const dropdownRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const itemRefs = useRef([]);

  const waitingForParent =
    !!dependentKey && (dependentValue === undefined || dependentValue === null);
  const inactive = disabled || waitingForParent;

  const term = searchTerm.trim().toLowerCase();
  let filteredOptions = options.filter((opt) =>
    dependentKey && !waitingForParent
      ? opt[dependentKey] === dependentValue
      : true,
  );
  if (sort)
    filteredOptions = [...filteredOptions].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  if (filterLocally && term)
    filteredOptions = filteredOptions.filter((opt) =>
      opt.name.toLowerCase().includes(term),
    );

  const selectedOption =
    options.find((opt) => opt.id === value) ??
    (selectedOptionProp?.id === value ? selectedOptionProp : undefined);

  const setTerm = (next) => {
    setSearchTerm(next);
    setHighlightedIndex(0);
    onSearchChange?.(next);
  };

  const close = () => {
    setIsOpen(false);
    if (searchTerm) setTerm("");
    setHighlightedIndex(0);
  };

  const open = () => {
    if (inactive) return;
    const current = filteredOptions.findIndex((o) => o.id === value);
    setHighlightedIndex(current >= 0 ? current : 0);
    setIsOpen(true);
  };

  const handleSelect = (option) => {
    if (option.disabled) return;
    onChange(option.id);
    close();
    inputRef.current?.focus();
  };

  const clearSelection = (e) => {
    e.stopPropagation();
    onChange(null);
    setTerm("");
    inputRef.current?.focus();
    setIsOpen(true);
  };

  const move = (step) => {
    if (!filteredOptions.length) return;
    setHighlightedIndex(
      (prev) => (prev + step + filteredOptions.length) % filteredOptions.length,
    );
  };

  const handleKeyDown = (e) => {
    if (inactive) return;
    if (!isOpen) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        open();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filteredOptions[highlightedIndex])
        handleSelect(filteredOptions[highlightedIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      close();
    }
  };

  // Keep the highlighted option in view.
  useEffect(() => {
    const el = itemRefs.current[highlightedIndex];
    if (el && listRef.current) {
      const elTop = el.offsetTop;
      const elBottom = elTop + el.offsetHeight;
      const listScrollTop = listRef.current.scrollTop;
      const listHeight = listRef.current.offsetHeight;
      if (elTop < listScrollTop) listRef.current.scrollTop = elTop;
      else if (elBottom > listScrollTop + listHeight)
        listRef.current.scrollTop = elBottom - listHeight;
    }
  }, [highlightedIndex, isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsOpen(false);
        setSearchTerm("");
        setHighlightedIndex(0);
        onSearchChange?.("");
        onBlur?.();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, onBlur, onSearchChange]);

  // Open upwards / right-aligned when there is no room below / to the right.
  useEffect(() => {
    if (isOpen && dropdownRef.current) {
      inputRef.current?.focus();
      const rect = dropdownRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const dropdownHeight = 240;
      setDropUp(spaceBelow < dropdownHeight && rect.top > dropdownHeight);
      setAlignRight(window.innerWidth - rect.left < rect.width);
    }
  }, [isOpen]);

  // A disabled box closes.
  useEffect(() => {
    if (inactive) setIsOpen(false);
  }, [inactive]);

  const optionText = (option) => {
    if (secondaryField && option[secondaryField])
      return `${option[secondaryField]} - ${option.name}`;
    if (
      !waitingForParent &&
      dependentKey &&
      secondaryFieldOptions &&
      secondaryField
    ) {
      const parent = secondaryFieldOptions.find(
        (item) => item.id === dependentValue,
      );
      if (parent) return `${parent[secondaryField]} - ${option.name}`;
    }
    return option.name;
  };

  const showClear = clearable && !inactive && (value || searchTerm);
  const errorMessage = typeof error === "string" ? error : error?.message;
  const activeId =
    isOpen && filteredOptions[highlightedIndex]
      ? `${id}-opt-${highlightedIndex}`
      : undefined;

  return (
    <div className={`w-full min-w-0 ${className}`}>
      <div className="flex gap-1 flex-col">
        {label && (
          <label
            htmlFor={id}
            className="text-sm font-medium text-secondary-text"
            data-required={required || undefined}>
            {label}
          </label>
        )}

        <div ref={dropdownRef} className="relative">
          <div
            onClick={() => (isOpen ? close() : open())}
            // Same frame as TextInput: border, darker on hover, brand border + soft ring when focused or open.
            className={`flex items-center justify-between rounded-lg border bg-text-input-color py-1.5 pl-2 pr-2 transition-all duration-150 ${
              error
                ? "border-error-color hover:border-error-color focus-within:ring-3 focus-within:ring-error-color/20"
                : isOpen
                  ? "border-brand-primary ring-3 ring-brand-primary/20"
                  : "border-border-color hover:border-border-dark-color focus-within:border-brand-primary focus-within:ring-3 focus-within:ring-brand-primary/20"
            } ${isOpen && error ? "ring-3 ring-error-color/20" : ""} ${inactive ? "opacity-60 cursor-not-allowed hover:border-border-color" : "cursor-pointer"}`}>
            {error ? (
              <CircleAlertIcon
                title={errorMessage}
                className="w-5 h-5 text-error-color mr-3 flex-shrink-0"
              />
            ) : Icon ? (
              <Icon className="w-5 h-5 text-primary-text mr-3 flex-shrink-0 pointer-events-none" />
            ) : null}

            <div className="flex flex-grow min-w-0 mr-2">
              <input
                ref={(el) => {
                  inputRef.current = el;
                  if (typeof ref === "function") ref(el);
                  else if (ref) ref.current = el;
                }}
                id={id}
                name={name}
                type="text"
                role="combobox"
                autoComplete="off"
                aria-expanded={isOpen}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={activeId}
                aria-required={required || undefined}
                aria-invalid={error ? true : undefined}
                aria-describedby={hint || errorMessage ? helpId : undefined}
                disabled={inactive}
                value={isOpen ? searchTerm : selectedOption?.name || ""}
                readOnly={!isOpen}
                onChange={(e) => setTerm(e.target.value)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!isOpen) open();
                }}
                onKeyDown={handleKeyDown}
                placeholder={
                  waitingForParent
                    ? (dependentPlaceholder ??
                      `Please select a ${dependentKey.replace(/_/g, " ")} first`)
                    : selectedOption?.name || placeholder
                }
                className={`w-full h-full text-sm outline-none bg-transparent truncate placeholder:text-sm placeholder:text-muted disabled:cursor-not-allowed ${
                  !selectedOption && !searchTerm
                    ? "text-sm text-muted"
                    : "text-sm text-primary-text"
                }`}
              />
            </div>

            {showClear && (
              <button
                type="button"
                tabIndex={-1}
                onClick={clearSelection}
                className="flex items-center justify-center p-0.5 text-primary-text hover:bg-secondary-bg mx-1 rounded-sm cursor-pointer"
                aria-label={label ? `Clear ${label}` : "Clear"}>
                <XIcon className="w-5 h-5" />
              </button>
            )}

            <div
              className="hover:bg-secondary-bg p-0.5 rounded-sm ml-1"
              aria-hidden="true">
              <ChevronDownIcon
                className={`stroke-primary-text w-5 h-5 transform transition-transform duration-300 ${isOpen ? "-rotate-180" : ""}`}
              />
            </div>
          </div>

          {isOpen && (
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={label}
              className={`absolute z-20 w-full border border-border-color rounded-lg shadow-md max-h-60 overflow-y-auto py-1 bg-secondary-bg
              ${dropUp ? "bottom-full mb-1" : "mt-1"}
              ${alignRight ? "right-0" : "left-0"}`}>
              {filteredOptions.length > 0 ? (
                filteredOptions.map((option, index) => (
                  <li
                    key={option.id}
                    id={`${id}-opt-${index}`}
                    role="option"
                    aria-selected={option.id === value}
                    aria-disabled={option.disabled || undefined}
                    ref={(el) => (itemRefs.current[index] = el)}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => handleSelect(option)}
                    className="px-2 py-1">
                    <div
                      className={`rounded-md px-4 py-1 ${option.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"} ${
                        highlightedIndex === index
                          ? "bg-brand-primary text-white"
                          : "text-primary-text hover:bg-brand-primary/10"
                      }`}>
                      {optionText(option)}
                      {option.hint && (
                        <span
                          className={`block text-xs ${highlightedIndex === index ? "text-white/80" : "text-secondary-text"}`}>
                          {option.hint}
                        </span>
                      )}
                    </div>
                  </li>
                ))
              ) : (
                <li className="px-4 py-2 text-sm text-secondary-text">
                  {emptyMessage}
                </li>
              )}
            </ul>
          )}
        </div>
        {(errorMessage || hint) && (
          <p
            id={helpId}
            className={`text-xs ${errorMessage ? "text-error-color" : "text-secondary-text"}`}>
            {errorMessage || hint}
          </p>
        )}
      </div>
    </div>
  );
};

export default RHFComboBox;
