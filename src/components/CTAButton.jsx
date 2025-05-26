import clsx from "clsx";

const CTAButton = ({
  type,
  text,
  icon: Icon,
  callbackFn,
  width = "w-fit",
  height = "h-fit",
}) => {
  const colorClasses = {
    cancel:
      "border border-error-btn-border bg-error-btn-bg text-primary-text hover:bg-error-btn-bg-hover hover:border-error-btn-border-hover",
    main: "border border-cta-btn-border bg-cta-btn-bg text-primary-text hover:bg-cta-btn-bg-hover hover:border-cta-btn-border-hover",
    secondary:
      "border border-border-color text-primary-text hover:border-border-dark-color hover:text-primary-text",
    success:
      "border border-success-btn-border bg-success-btn-bg text-primary-text hover:bg-success-btn-bg-hover hover:border-success-btn-border-hover hover:text-primary-text",
    neutral:
      "border border-neutral-btn-border bg-neutral-btn-bg text-primary-text hover:bg-neutral-btn-bg-hover hover:border-neutral-btn-border-hover hover:text-primary-text",
  };

  const baseClass =
    "flex flex-row gap-2 py-1 px-2 items-center justify-center rounded-lg active:scale-97 transition-transform duration-200 ease-in-out cursor-pointer";

  return (
    <button
      onClick={callbackFn}
      className={clsx(
        baseClass,
        colorClasses[type],
        width || "w-fit",
        height || "h-fit"
      )}>
      {Icon && <Icon className="h-6 w-6" />}
      {text}
    </button>
  );
};

export default CTAButton;
