import React from "react";

const CardSelect = ({
  options,
  label = "Select an option",
  value,
  onChange,
  titleKey,
  descriptionKey,
  valueKey,
  package: isPackage = false,
}) => {
  const getPackageColor = (title) => {
    const lower = title.toLowerCase();
    if (lower.includes("gold")) return "bg-yellow-400";
    if (lower.includes("silver")) return "bg-gray-300";
    if (lower.includes("bronze")) return "bg-amber-600";
    return "border border-primary-text bg-transparent"; // fallback
  };

  return (
    <div className="flex flex-col">
      <p className="text-primary-text mb-2">{label}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const selected = value === option[valueKey];
          const title = option[titleKey];
          const circleColor = getPackageColor(title);

          return (
            <button
              title={option[titleKey]}
              key={option[valueKey]}
              type="button"
              onClick={() => onChange(option[valueKey])}
              className={`cursor-pointer flex-1 shadow-s min-w-[calc(50%-0.5rem)] p-2 rounded-2xl text-left
              ${
                selected
                  ? "border-cta-color border bg-cta-color/10 shadow-md"
                  : "border border-transparent hover:border-cta-color/50 bg-tertiary-bg hover:bg-cta-color/5"
              }`}>
              {isPackage ? (
                <div
                  className={`h-6 w-6 mb-2 border border-border-color/50 shadow-s rounded-full ${circleColor}`}></div>
              ) : (
                option.icon && (
                  <option.icon
                    className={`h-6 w-6 mb-2 ${
                      selected ? "text-cta-color" : "text-secondary-text"
                    }`}
                  />
                )
              )}

              <h3
                className={`font-medium truncate ${
                  selected ? "text-cta-color" : "text-primary-text"
                }`}>
                {title}
              </h3>

              {!isPackage && option[descriptionKey] && (
                <p className="text-sm text-secondary-text mt-1">
                  {option[descriptionKey]}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default CardSelect;
