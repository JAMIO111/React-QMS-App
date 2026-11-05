import { LoaderCircleIcon } from "@/components/icons";

/**
 * A button that shows a spinner and ignores clicks while `loading` (a mutation or submit in
 * progress). Styling comes from `className`, as with a plain button; `loadingText` replaces the
 * label while busy. Defaults to type="button".
 */
const LoadingButton = ({ loading = false, loadingText, disabled, type = "button", className = "", children, ...props }) => (
  <button
    type={type}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    className={`${className} inline-flex items-center justify-center gap-1.5 disabled:cursor-not-allowed`}
    {...props}>
    {loading && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
    {loading && loadingText ? loadingText : children}
  </button>
);

export default LoadingButton;
