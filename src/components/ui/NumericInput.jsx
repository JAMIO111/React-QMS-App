import React, { forwardRef } from "react";
import { FaPlus, FaMinus } from "react-icons/fa6";

const NumericInput = forwardRef(
  ({ value, onChange, min = -Infinity, max = Infinity, ...rest }, ref) => {
    const handleInputChange = (e) => {
      let val = e.target.value;

      // Allow empty input for typing
      if (val === "") {
        onChange?.("");
        rest.onChange?.(e); // RHF's onChange
        return;
      }

      val = Number(val);

      // Clamp value to min/max
      if (val < min) val = min;
      if (val > max) val = max;

      onChange?.(val);
      rest.onChange?.({ ...e, target: { ...e.target, value: val } });
    };

    const increment = () => {
      if (value === "" || value >= max) return;
      const newVal = value + 1;
      onChange?.(newVal);
      rest.onChange?.({ target: { value: newVal } });
    };

    const decrement = () => {
      if (value === "" || value <= min) return;
      const newVal = value - 1;
      onChange?.(newVal);
      rest.onChange?.({ target: { value: newVal } });
    };

    return (
      <div
        className={`${
          rest.error ? "border-error-color" : "border-primary-bg"
        } flex shadow-m bg-primary-bg flex-row border w-fit items-center rounded-full p-1 gap-2`}>
        <button
          type="button"
          disabled={value !== "" && value <= min}
          className="shadow-s group hover:bg-brand-primary/70 p-2 bg-text-input-color cursor-pointer rounded-full disabled:opacity-40 disabled:cursor-not-allowed active:scale-90 active:transition-transform active:duration-100"
          onClick={decrement}>
          <FaMinus className="group-hover:text-primary-bg w-6 h-6 text-secondary-text" />
        </button>

        <input
          ref={ref}
          min={min}
          max={max}
          type="number"
          className="w-12 no-spin text-center text-primary-text font-semibold text-xl outline-none"
          value={value}
          onChange={handleInputChange}
          {...rest} // lets RHF pass `name`, `onBlur`, etc.
        />

        <button
          type="button"
          disabled={value !== "" && value >= max}
          className="shadow-s group hover:bg-brand-primary/70 p-2 bg-text-input-color cursor-pointer rounded-full disabled:opacity-40 disabled:cursor-not-allowed active:scale-90 active:transition-transform active:duration-100"
          onClick={increment}>
          <FaPlus className="group-hover:text-primary-bg w-6 h-6 text-secondary-text" />
        </button>
      </div>
    );
  }
);

NumericInput.displayName = "NumericInput";

export default NumericInput;
