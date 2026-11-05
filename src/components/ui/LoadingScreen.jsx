import logo from "../../assets/fortress-qms.png";

const SIZES = {
  // ring and logo sizes in px, text class, and the minimum height of the area
  sm: { ring: 44, logo: 28, text: "text-sm", area: "min-h-24 py-4" },
  // for footers and toolbars: logo and text side by side
  inline: { ring: 24, logo: 14, text: "text-sm", area: "" },
  md: { ring: 80, logo: 52, text: "text-base", area: "min-h-48 py-10" },
};

/**
 * The loading state for a page, panel or table body: the Fortress logo inside a spinning ring with
 * "Loading, please wait…" underneath, centred in the space it is given. The background is
 * transparent, so it works on any surface. `size="sm"` suits cards and table cells; `fullscreen`
 * fills the viewport (route and sign-in gates); `size="inline"` is a compact logo-and-text row for
 * footers such as the table footer.
 */
const LoadingScreen = ({ text = "Loading, please wait…", size = "md", fullscreen = false, className = "" }) => {
  const s = SIZES[size] ?? SIZES.md;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center justify-center ${size === "inline" ? "w-fit flex-row gap-2" : `w-full flex-col gap-3 ${fullscreen ? "h-screen" : s.area}`} ${className}`}>
      <div className="relative flex items-center justify-center" style={{ width: s.ring, height: s.ring }} aria-hidden="true">
        <span className="absolute inset-0 rounded-full border-2 border-border-color" />
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-brand-primary" />
        <img src={logo} alt="" width={s.logo} height={s.logo} className="animate-pulse rounded-sm" draggable={false} />
      </div>
      <p className={`${s.text} text-secondary-text`}>{text}</p>
    </div>
  );
};

export default LoadingScreen;
