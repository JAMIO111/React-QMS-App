import { Link } from "react-router-dom";
import { twMerge } from "tailwind-merge";

/**
 * The app's one button. Every main, secondary, neutral, danger and success button uses it, so they all look, scale when pressed,
 * dim when disabled and focus the same way.
 *
 *   <CTAButton type="main" text="Save" icon={SaveIcon} callbackFn={save} />          // short form (toolbars)
 *   <CTAButton type="neutral" size="md" onClick={close}>Cancel</CTAButton>           // children, any button attribute
 *   <CTAButton type="main" size="lg" buttonType="submit" disabled={busy}>Save</CTAButton>
 *   <CTAButton type="secondary" size="md" to="/Settings">Open settings</CTAButton>   // an in-app link that looks like a button
 *
 * - `type`: main (alias primary), secondary, neutral, success, cancel (alias danger).
 * - `size`: "default" (toolbar), "md" (forms and dialogs), "lg" (the main action of a form).
 * - `buttonType`: the HTML type (button, submit, reset); it is "button" unless you say otherwise.
 * - `to`: renders a router link instead of a button. `className` adds to (and wins over) the defaults, e.g. `w-full`.
 * - Any other attribute (aria-label, form, id, data-*, onClick, ref …) goes to the element.
 */
const VARIANTS = {
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
const ALIASES = { primary: "main", danger: "cancel" };

const SIZES = {
  default: "py-1 px-2 text-md",
  md: "py-1.5 px-3 text-sm",
  lg: "py-2 px-4 text-sm",
};

const CTAButton = ({
  type = "main",
  size = "default",
  title,
  text,
  children,
  icon: Icon,
  callbackFn,
  onClick,
  to,
  className,
  width = "w-fit",
  height = "h-fit",
  iconSize = "h-5 w-5",
  textSize = "text-sm",
  borderRadius = "rounded-lg",
  disabled = false,
  buttonType = "button",
  ...rest
}) => {
  const content = children ?? text;
  const classes = twMerge(
    "flex flex-row gap-2 items-center justify-center transition-transform duration-200 ease-in-out",
    children === undefined && "truncate",
    SIZES[size] ?? SIZES.default,
    textSize,
    VARIANTS[ALIASES[type] ?? type] ?? VARIANTS.main,
    disabled
      ? "opacity-50 cursor-not-allowed"
      : "cursor-pointer active:scale-97",
    width,
    height,
    borderRadius,
    className,
  );
  const inner = (
    <>
      {Icon && <Icon className={iconSize} />}
      {content}
    </>
  );

  if (to && !disabled) {
    return (
      <Link
        to={to}
        title={title}
        onClick={onClick ?? callbackFn}
        className={classes}
        {...rest}>
        {inner}
      </Link>
    );
  }
  return (
    <button
      type={buttonType}
      disabled={disabled}
      title={title}
      onClick={onClick ?? callbackFn}
      className={classes}
      {...rest}>
      {inner}
    </button>
  );
};

export default CTAButton;
