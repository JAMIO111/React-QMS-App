import { useState } from "react";

const FloatingTextInput = ({ label, type = "text", value, onChange, id }) => {
  const [isFocused, setIsFocused] = useState(false);
  const isFloating = isFocused || value;

  return (
    <div className="relative w-full">
      <input
        id={id}
        type={type}
        value={value}
        onChange={onChange}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        className="peer w-full bg-text-input-color border border-border-color rounded-lg h-10 text-primary-text hover:border-border-dark-color placeholder-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
        placeholder={label}
      />
      <label
        htmlFor={id}
        className={`absolute left-3 transition-all duration-200 pointer-events-none ${
          isFloating
            ? "-top-5 bg-secondary-bg text-xs text-primary-text"
            : "top-2.5 text-sm text-muted"
        }`}>
        {label}
      </label>
    </div>
  );
};

export default FloatingTextInput;
