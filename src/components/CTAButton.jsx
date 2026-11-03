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
  disabled = false,
}) => {
  const baseClass =
    "flex flex-row gap-2 py-1 px-2 truncate items-center justify-center transition-transform duration-200 ease-in-out";

  const stateClasses = disabled
    ? "opacity-50 cursor-not-allowed"
    : "cursor-pointer active:scale-97";

  const colorClasses = {
    cancel: clsx(
      "border border-error-btn-border bg-error-btn-bg text-primary-text",
      disabled
        ? "opacity-50 cursor-not-allowed"
        : "hover:bg-error-btn-bg-hover hover:border-error-btn-border-hover",
    ),
    main: clsx(
      "border border-cta-btn-border bg-cta-btn-bg text-primary-text",
      disabled
        ? "opacity-50 cursor-not-allowed"
        : "hover:bg-cta-btn-bg-hover hover:border-cta-btn-border-hover",
    ),
    secondary: clsx(
      "border border-border-color text-primary-text",
      disabled
        ? "opacity-50 cursor-not-allowed"
        : "hover:border-border-dark-color hover:text-primary-text",
    ),
    success: clsx(
      "border border-success-btn-border bg-success-btn-bg text-primary-text",
      disabled
        ? "opacity-50 cursor-not-allowed"
        : "hover:bg-success-btn-bg-hover hover:border-success-btn-border-hover hover:text-primary-text",
    ),
    neutral: clsx(
      "border border-neutral-btn-border bg-neutral-btn-bg text-primary-text",
      disabled
        ? "opacity-50 cursor-not-allowed"
        : "hover:bg-neutral-btn-bg-hover hover:border-neutral-btn-border-hover hover:text-primary-text",
    ),
  };

  const baseClass = `${textSize} flex cursor-pointer flex-row gap-2 py-1 px-2 truncate items-center justify-center rounded-lg active:scale-97 transition-transform duration-200 ease-in-out`;

  return (
    <button
      disabled={disabled}
      title={title}
      onClick={callbackFn}
      className={clsx(baseClass, colorClasses[type], width, height)}>
      {Icon && <Icon className={iconSize} />}
      {text}
    </button>
  );
};

export default CTAButton;
