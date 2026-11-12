import { BAND_CELL, BAND_LABEL, cellBand } from "../../lib/risk";

/**
 * The 5 × 5 matrix: likelihood up the side (most likely at the top), consequence along the bottom (most serious on the right).
 * Every cell says its score and band in words; the colour only repeats it. `onPick(likelihood, consequence)` makes the cells buttons
 * (choosing a score, or changing a cell's band in the editor); `selected` marks the chosen cell; `marks` puts a count or a label in cells.
 */
const RiskMatrix = ({ config, selected, onPick, cellLabel, marks, compact = false, ariaLabel = "Risk matrix" }) => {
  if (!config) return null;
  const levels = [5, 4, 3, 2, 1];
  const size = compact ? "h-9 text-xs" : "h-14 text-sm";
  return (
    <div className="overflow-x-auto">
      <table aria-label={ariaLabel} className="border-separate border-spacing-1 text-sm">
        <tbody>
          {levels.map((l) => (
            <tr key={l}>
              <th scope="row" className="max-w-40 pr-2 text-right font-normal text-secondary-text">
                <span className="font-medium text-primary-text">{l}</span> {config.likelihood[l - 1]?.label}
              </th>
              {[1, 2, 3, 4, 5].map((c) => {
                const band = cellBand(config, l, c);
                const chosen = selected && selected.likelihood === l && selected.consequence === c;
                const words = `${config.likelihood[l - 1]?.label} and ${config.consequence[c - 1]?.label}: ${l * c}, ${BAND_LABEL[band]}`;
                const mark = marks?.(l, c);
                const body = (
                  <>
                    <span className="font-semibold">{l * c}</span>
                    {!compact && <span className="block text-[0.7rem] leading-tight">{BAND_LABEL[band]}</span>}
                    {mark !== undefined && mark !== null && <span className="block text-[0.7rem] font-semibold leading-tight">{mark}</span>}
                  </>
                );
                const cls = `${size} w-16 rounded-lg ${BAND_CELL[band]} ${chosen ? "outline outline-4 outline-offset-1 outline-primary-text" : ""}`;
                return (
                  <td key={c} className="p-0 text-center">
                    {onPick ? (
                      <button type="button" aria-label={cellLabel ? cellLabel(l, c, band) : words} aria-pressed={selected ? !!chosen : undefined} onClick={() => onPick(l, c)} className={`${cls} transition-transform active:scale-95`}>
                        {body}
                      </button>
                    ) : (
                      <div title={words} className={`${cls} flex flex-col items-center justify-center`}>
                        <span className="sr-only">{words}</span>
                        <span aria-hidden="true">{body}</span>
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr>
            <td />
            {[1, 2, 3, 4, 5].map((c) => (
              <th key={c} scope="col" className="w-16 px-0.5 pt-1 align-top text-xs font-normal text-secondary-text">
                <span className="block font-medium text-primary-text">{c}</span>
                {config.consequence[c - 1]?.label}
              </th>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
};

export default RiskMatrix;
