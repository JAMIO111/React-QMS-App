import { ClipboardListIcon, HistoryIcon, ShieldCheckIcon } from "@/components/icons";
import Mark from "../../assets/fortress-qms-mark.png";

/**
 * Engineering drawing drawn in thin blueprint lines: a flange in front and side view with centre
 * lines, a bolt-hole circle, dimensions, a datum and a tolerance frame. Decorative only.
 */
const TechnicalDrawing = () => {
  const holes = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    return [300 + 96 * Math.cos(a), 330 + 96 * Math.sin(a)];
  });
  return (
    <svg
      viewBox="80 140 800 540"
      className="absolute -right-16 top-1/2 h-[82%] max-h-[700px] w-auto -translate-y-1/2 opacity-40"
      // Fade the drawing out towards the text on the left.
      style={{ maskImage: "linear-gradient(to right, transparent 0%, black 45%)", WebkitMaskImage: "linear-gradient(to right, transparent 0%, black 45%)" }}
      fill="none"
      aria-hidden="true">
      <defs>
        <marker id="bp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="#7cb6ff" />
        </marker>
      </defs>
      <g stroke="#7cb6ff" strokeWidth="1.4">
        {/* Front view: flange, bore, bolt-hole circle */}
        <circle cx="300" cy="330" r="150" />
        <circle cx="300" cy="330" r="62" />
        <circle cx="300" cy="330" r="96" strokeDasharray="14 5 3 5" strokeOpacity="0.7" />
        {holes.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="13" />
        ))}
        {/* Centre lines */}
        <path d="M120 330H480M300 150V510" strokeDasharray="22 6 4 6" strokeOpacity="0.6" />
        {/* Side view (section) */}
        <rect x="560" y="180" width="70" height="300" />
        <rect x="630" y="268" width="150" height="124" />
        <path d="M560 268H630M560 392H630" strokeOpacity="0.7" />
        <path d="M545 330H800" strokeDasharray="22 6 4 6" strokeOpacity="0.6" />
        {/* Section hatching */}
        <g strokeOpacity="0.45" strokeWidth="1">
          {Array.from({ length: 12 }, (_, i) => (
            <path key={i} d={`M560 ${200 + i * 24}l70 -40`} />
          ))}
        </g>
        {/* Dimensions */}
        <g strokeWidth="1">
          <path d="M150 560H450" markerStart="url(#bp-arrow)" markerEnd="url(#bp-arrow)" />
          <path d="M150 340V575M450 340V575" strokeOpacity="0.5" />
          <path d="M560 540H780" markerStart="url(#bp-arrow)" markerEnd="url(#bp-arrow)" />
          <path d="M560 485V555M780 395V555" strokeOpacity="0.5" />
          <path d="M820 268V392" markerStart="url(#bp-arrow)" markerEnd="url(#bp-arrow)" />
          <path d="M785 268H835M785 392H835" strokeOpacity="0.5" />
          <path d="M366 264L420 190H520" />
        </g>
        {/* Datum and tolerance frame */}
        <rect x="270" y="610" width="60" height="34" />
        <path d="M300 610V585" />
        <rect x="560" y="600" width="230" height="40" />
        <path d="M600 600V640M690 600V640M740 600V640" />
        <circle cx="580" cy="620" r="10" />
        <path d="M580 608V632M568 620H592" strokeWidth="1" />
      </g>
      <g fill="#9cc8ff" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" fontSize="17" letterSpacing="1">
        <text x="270" y="552">Ø300</text>
        <text x="640" y="532">85 ±0.1</text>
        <text x="828" y="336" transform="rotate(90 828 336)">Ø124 H7</text>
        <text x="428" y="182">6× Ø26 EQ SP</text>
        <text x="428" y="204" fillOpacity="0.8">PCD Ø192</text>
        <text x="292" y="633">A</text>
        <text x="609" y="626">Ø0.05</text>
        <text x="709" y="626">A</text>
        <text x="756" y="626">B</text>
      </g>
    </svg>
  );
};

const POINTS = [
  { icon: ClipboardListIcon, title: "Non-conformances under control", text: "Raise, contain and close internal, customer and supplier NCs with costs and evidence." },
  { icon: HistoryIcon, title: "Audit-ready by default", text: "Every change recorded with who, when and why — ready for the next audit." },
  { icon: ShieldCheckIcon, title: "Secure across every site", text: "Organisation and site-level access, two-factor sign-in and private file storage." },
];

/** Right-hand side of the sign-in pages: Fortress QMS brand on a blueprint. Hidden on small screens. */
const BrandPanel = () => (
  <aside aria-label="About Fortress QMS" className="relative hidden overflow-hidden bg-[#05070c] text-white lg:flex lg:flex-col lg:justify-between lg:p-12">
    {/* Blueprint grid: fine lines every 24px, heavier every 120px. */}
    <div
      aria-hidden="true"
      className="absolute inset-0"
      style={{
        backgroundImage:
          "linear-gradient(rgba(124,182,255,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(124,182,255,0.07) 1px, transparent 1px)," +
          "linear-gradient(rgba(124,182,255,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(124,182,255,0.14) 1px, transparent 1px)",
        backgroundSize: "24px 24px, 24px 24px, 120px 120px, 120px 120px",
      }}
    />
    <div aria-hidden="true" className="absolute -left-32 top-1/4 h-[520px] w-[520px] rounded-full bg-[#2563eb]/25 blur-[120px]" />
    <TechnicalDrawing />
    <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-[#05070c] to-transparent" />

    <p className="relative font-mono text-xs uppercase tracking-[0.25em] text-[#9cc8ff]">Quality management for manufacturing</p>

    <div className="relative max-w-md py-8">
      <img src={Mark} alt="" className="mb-6 h-16 w-auto drop-shadow-[0_0_40px_rgba(37,99,235,0.45)] xl:mb-8 xl:h-24" />
      <h2 className="text-3xl font-semibold leading-tight xl:text-5xl">
        Quality you can
        <br />
        build on.
      </h2>
      <p className="mt-4 text-base text-white/70 xl:text-lg">Fortress QMS keeps your non-conformances, investigations and evidence in one secure, audit-ready place.</p>
    </div>

    {/* Compact rows on smaller screens; three cards side by side on wide ones. */}
    <ul className="relative grid max-w-2xl gap-3 xl:grid-cols-3 xl:gap-5">
      {POINTS.map(({ icon: Icon, title, text }) => (
        <li key={title} className="flex items-start gap-3 rounded-xl border border-white/10 bg-[#05070c]/70 p-3 backdrop-blur-sm xl:flex-col xl:gap-2 xl:p-4">
          <Icon className="mt-0.5 h-5 w-5 shrink-0 text-[#7cb6ff]" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold">{title}</p>
            <p className="text-xs leading-relaxed text-white/60">{text}</p>
          </div>
        </li>
      ))}
    </ul>
  </aside>
);

export default BrandPanel;
