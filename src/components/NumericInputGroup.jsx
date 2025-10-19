import NumericInput from "./ui/NumericInput";
import { forwardRef } from "react";
import { MdErrorOutline } from "react-icons/md";

const NumericInputGroup = forwardRef(
  (
    { label, value, onChange, icon: Icon, min = 0, max = 100, ...rest },
    ref
  ) => {
    return (
      <div className="py-2 flex flex-row justify-between items-center">
        <div
          title={rest.error ? rest.error.message : null}
          className={`shadow-m flex bg-primary-bg items-center rounded-full p-3 ${
            rest.error ? "border border-error-color" : null
          }`}>
          {rest.error ? (
            <MdErrorOutline className="text-error-color text-xl" />
          ) : (
            <Icon className="text-primary-text text-xl" />
          )}
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
