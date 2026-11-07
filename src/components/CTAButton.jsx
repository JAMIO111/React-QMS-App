import clsx from "clsx";

const CTAButton = ({
  type,
  title,
  text,
  icon: Icon,
  callbackFn,
  width = "w-fit",
  height = "h-fit",
  iconSize = "h-5 w-5",
  textSize = "text-md",
  borderRadius = "rounded-lg",
  disabled = false,
  buttonType = "button",
}) => {
  const baseClass =
    "flex flex-row gap-2 py-1 px-2 truncate items-center justify-center transition-transform duration-200 ease-in-out";

  const stateClasses = disabled
    ? "opacity-50 cursor-not-allowed"
    : "cursor-pointer active:scale-97";

  const colorClasses = {
    cancel:
      "border border-error-btn-border bg-error-btn-bg text-primary-text hover:bg-error-btn-bg-hover hover:border-error-btn-border-hover",
    main: "border border-cta-btn-border bg-cta-btn-bg text-primary-text hover:bg-cta-btn-bg-hover hover:border-cta-btn-border-hover",
    secondary:
      "border border-secondary-btn-border bg-secondary-btn-bg text-secondary-btn-text hover:bg-secondary-btn-bg-hover hover:border-secondary-btn-border-hover",
    success:
      "border border-success-btn-border bg-success-btn-bg text-primary-text hover:bg-success-btn-bg-hover hover:border-success-btn-border-hover",
    neutral:
      "border border-neutral-btn-border bg-neutral-btn-bg text-primary-text hover:bg-neutral-btn-bg-hover hover:border-neutral-btn-border-hover",
  };

  return (
    <button
      type={buttonType}
      disabled={disabled}
      title={title}
      onClick={callbackFn}
      className={clsx(
        textSize,
        baseClass,
        stateClasses,
        colorClasses[type],
        width,
        height,
        borderRadius
      )}>
      {Icon && <Icon className={iconSize} />}
      {text}
    </button>
  );
};

export default CTAButton;
