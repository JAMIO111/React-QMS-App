import excelLogo from "@/assets/integrations/excel.webp";
import restApiLogo from "@/assets/integrations/rest-api.webp";
import sqlServerLogo from "@/assets/integrations/sql-server.webp";
import { BRAND_MARKS } from "./brandMarks";

/** Logos kept as pictures (bundled with the app). */
const IMAGES = { file: excelLogo, api: restApiLogo, database: sqlServerLogo };

/** Microsoft's four squares (drawn here: it is four coloured rectangles). */
const MicrosoftMark = () => (
  <svg viewBox="0 0 23 23" className="h-7 w-7" aria-hidden="true">
    <path fill="#F25022" d="M1 1h10v10H1z" />
    <path fill="#7FBA00" d="M12 1h10v10H12z" />
    <path fill="#00A4EF" d="M1 12h10v10H1z" />
    <path fill="#FFB900" d="M12 12h10v10H12z" />
  </svg>
);

/** The logo tile of an integration card: a brand mark or logo picture on a white tile, so its colours hold in dark mode. */
const ProviderLogo = ({ mark, name, className = "" }) => {
  const base = `flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${className}`;
  if (IMAGES[mark]) {
    return (
      <span className={`${base} border border-border-color bg-white p-1.5`} role="img" aria-label={`${name} logo`}>
        <img src={IMAGES[mark]} alt="" className="max-h-full max-w-full object-contain" />
      </span>
    );
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
