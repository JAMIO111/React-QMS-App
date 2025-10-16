import NumericInput from "./ui/NumericInput";
import { forwardRef } from "react";

const NumericInputGroup = forwardRef(
  (
    { label, value, onChange, icon: Icon, min = 0, max = 100, ...rest },
    ref
  ) => {
    return (
      <div className="py-2 flex flex-row justify-between items-center">
        <div className="shadow-m flex bg-primary-bg items-center rounded-full p-3">
          <Icon className="text-primary-text text-xl" />
        </div>
        <p className="text-primary-text text-xl px-5 text-left flex-1 font-medium">
          {label}
        </p>
        <NumericInput
          ref={ref}
          value={value ?? rest.value ?? ""}
          onChange={onChange}
          min={min}
          max={max}
          {...rest} // this makes RHF props flow down
        />
      </div>
    );
  }
);

NumericInputGroup.displayName = "NumericInputGroup";

export default NumericInputGroup;
