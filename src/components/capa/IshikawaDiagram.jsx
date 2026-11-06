import { ISHIKAWA_CATEGORIES } from "../../lib/capa";

const lines = (text, max) => {
  const out = [];
  let line = "";
  for (const word of String(text).split(/\s+/)) {
    if ((line + " " + word).trim().length > max && line) {
      out.push(line);
      line = word;
    } else line = (line + " " + word).trim();
  }
  if (line) out.push(line);
  return out.slice(0, 4);
};

const TOP = ISHIKAWA_CATEGORIES.slice(0, 3);
const BOTTOM = ISHIKAWA_CATEGORIES.slice(3);
const SPINE_Y = 210;
const BONE_X = [160, 400, 640];
const MAX_SHOWN = 5;

/**
 * An Ishikawa (fishbone) diagram drawn as SVG from the saved data: the effect at the head, six category bones, causes written along the bones
 * (probable ones in bold). Longer lists show the first few and "+ n more". Colours follow the theme through currentColor.
 */
const IshikawaDiagram = ({ effect, categories }) => {
  const byKey = new Map((categories ?? []).map((c) => [c.key, c.causes ?? []]));
  const bone = (cat, x, top) => {
    const causes = byKey.get(cat.key) ?? [];
    const y0 = top ? 70 : 350;
    const dir = top ? 1 : -1;
    return (
      <g key={cat.key}>
        <line x1={x} y1={y0} x2={x + 110} y2={SPINE_Y} stroke="currentColor" strokeOpacity="0.55" strokeWidth="2" />
        <rect x={x - 70} y={top ? 36 : 352} width="140" height="30" rx="6" fill="none" stroke="currentColor" strokeOpacity="0.6" />
        <text x={x} y={top ? 56 : 372} textAnchor="middle" fontSize="15" fontWeight="600" fill="currentColor">{cat.label}</text>
        {causes.slice(0, MAX_SHOWN).map((c, i) => {
          const y = y0 + dir * (26 + i * 24);
          const bx = x + ((y - y0) / (SPINE_Y - y0)) * 110;
          return (
            <g key={c.id}>
              <line x1={bx - 70} y1={y} x2={bx} y2={y} stroke="currentColor" strokeOpacity="0.35" />
              <text x={bx - 74} y={y - 4} textAnchor="end" fontSize="12" fontWeight={c.probable ? 700 : 400} fill="currentColor">{c.text.length > 30 ? `${c.text.slice(0, 29)}…` : c.text}</text>
            </g>
          );
        })}
        {causes.length > MAX_SHOWN && <text x={x - 74} y={y0 + dir * (26 + MAX_SHOWN * 24)} textAnchor="end" fontSize="12" fill="currentColor" fillOpacity="0.7">+ {causes.length - MAX_SHOWN} more</text>}
      </g>
    );
  };
  return (
    <svg viewBox="0 0 1000 420" role="img" aria-label={`Ishikawa diagram: ${effect || "effect not described"}`} className="h-auto w-full text-primary-text">
      <line x1="30" y1={SPINE_Y} x2="790" y2={SPINE_Y} stroke="currentColor" strokeWidth="3" />
      <polygon points="790,198 812,210 790,222" fill="currentColor" />
      <rect x="812" y="160" width="176" height="100" rx="10" fill="none" stroke="currentColor" strokeWidth="2" />
      {lines(effect || "Effect", 20).map((l, i, all) => (
        <text key={i} x="900" y={210 + (i - (all.length - 1) / 2) * 18 + 5} textAnchor="middle" fontSize="15" fontWeight="600" fill="currentColor">{l}</text>
      ))}
      {TOP.map((c, i) => bone(c, BONE_X[i], true))}
      {BOTTOM.map((c, i) => bone(c, BONE_X[i], false))}
    </svg>
  );
};

export default IshikawaDiagram;
