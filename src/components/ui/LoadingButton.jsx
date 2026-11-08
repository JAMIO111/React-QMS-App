import { LoaderCircleIcon } from "@/components/icons";
import CTAButton from "../CTAButton";

/**
 * A CTAButton that shows a spinner and ignores clicks while `loading` (a mutation or submit in progress).
 * `variant` is the button style (main, secondary, neutral, danger, success; default neutral); `size`, `className`
 * and every other CTAButton prop work as usual. `loadingText` replaces the label while busy.
 */
const LoadingButton = ({ loading = false, loadingText, disabled, variant = "neutral", size = "md", children, ...props }) => (
  <CTAButton type={variant} size={size} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
    {loading && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
    {loading && loadingText ? loadingText : children}
  </CTAButton>
);

export default LoadingButton;
