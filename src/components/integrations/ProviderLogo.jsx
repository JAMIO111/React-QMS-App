import { DatabaseIcon, FileSpreadsheetIcon, WebhookIcon } from "@/components/icons";
import { BRAND_MARKS } from "./brandMarks";

const ICONS = {
  file: { Icon: FileSpreadsheetIcon, tone: "bg-success-color/15 text-success-color" },
  api: { Icon: WebhookIcon, tone: "bg-theme/15 text-theme" },
  database: { Icon: DatabaseIcon, tone: "bg-[#CC2927]/10 text-[#CC2927]" },
};

/** Microsoft's four squares (drawn here: it is four coloured rectangles). */
const MicrosoftMark = () => (
  <svg viewBox="0 0 23 23" className="h-7 w-7" aria-hidden="true">
    <path fill="#F25022" d="M1 1h10v10H1z" />
    <path fill="#7FBA00" d="M12 1h10v10H12z" />
    <path fill="#00A4EF" d="M1 12h10v10H1z" />
    <path fill="#FFB900" d="M12 12h10v10H12z" />
  </svg>
);

/** The logo tile of an integration card: a brand mark on a white tile (so its colours hold in dark mode), or one of our icons. */
const ProviderLogo = ({ mark, name, className = "" }) => {
  const base = `flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${className}`;
  const icon = ICONS[mark];
  if (icon) {
    const { Icon, tone } = icon;
    return <span className={`${base} ${tone}`} role="img" aria-label={`${name} logo`}><Icon className="h-6 w-6" /></span>;
  }
  const brand = BRAND_MARKS[mark];
  return (
    <span className={`${base} border border-border-color bg-white`} role="img" aria-label={`${name} logo`}>
      {mark === "microsoft" ? (
        <MicrosoftMark />
      ) : brand ? (
        <svg viewBox="0 0 24 24" className="h-7 w-7" aria-hidden="true"><path fill={brand.hex} d={brand.path} /></svg>
      ) : (
        <span className="text-sm font-semibold text-gray-700">{name.slice(0, 2)}</span>
      )}
    </span>
  );
};

export default ProviderLogo;
