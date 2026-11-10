import CTAButton from "../CTAButton";

/**
 * A CTAButton whose `variant` names the style (main, secondary, neutral, danger, success; default neutral) and whose size defaults to md.
 * Kept for the places that use it; `loading` and `loadingText` are CTAButton's own now.
 */
const LoadingButton = ({ variant = "neutral", size = "md", ...props }) => <CTAButton type={variant} size={size} {...props} />;

export default LoadingButton;
