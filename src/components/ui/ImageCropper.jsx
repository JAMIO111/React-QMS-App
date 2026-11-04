import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MinusIcon, PlusIcon } from "@/components/icons";

const MAX_ZOOM = 4;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Square crop of an image: drag (or arrow keys) to move it, zoom with the slider, the mouse wheel
 * or +/−. The image always covers the square. Reports the crop in the image's own pixels through
 * onCropChange({ x, y, size }) — feed it to cropToBlob() (src/lib/cropImage.js).
 */
const ImageCropper = ({ src, size = 288, onCropChange, round = false }) => {
  const [natural, setNatural] = useState(null); // { w, h }
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 }); // image top-left inside the square, in screen px
  const drag = useRef(null);
  const report = useRef(onCropChange);
  report.current = onCropChange;

  // Scale at zoom 1: the shorter side fills the square.
  const base = natural ? size / Math.min(natural.w, natural.h) : 1;
  const scale = base * zoom;
  const shown = useMemo(() => (natural ? { w: natural.w * scale, h: natural.h * scale } : { w: size, h: size }), [natural, scale, size]);
  const fit = useCallback((o, s = shown) => ({ x: clamp(o.x, size - s.w, 0), y: clamp(o.y, size - s.h, 0) }), [shown, size]);

  // A new image starts centred at zoom 1.
  useEffect(() => {
    setNatural(null);
    setZoom(1);
  }, [src]);
  const onLoad = (e) => {
    const w = e.currentTarget.naturalWidth;
    const h = e.currentTarget.naturalHeight;
    const s = size / Math.min(w, h);
    setNatural({ w, h });
    setOffset({ x: (size - w * s) / 2, y: (size - h * s) / 2 });
  };

  useEffect(() => {
    if (!natural) return;
    // Whole-ish image pixels, no -0 or floating-point noise.
    const r = (v) => Math.round(v * 1e4) / 1e4 + 0;
    report.current?.({ x: r(Math.max(0, -offset.x / scale)), y: r(Math.max(0, -offset.y / scale)), size: r(size / scale) });
  }, [natural, offset, scale, size]);

  /** Zoom around a point of the square (default its centre), keeping that point still. */
  const zoomTo = (next, at = { x: size / 2, y: size / 2 }) => {
    if (!natural) return;
    const z = clamp(next, 1, MAX_ZOOM);
    const k = z / zoom;
    const s = { w: natural.w * base * z, h: natural.h * base * z };
    setZoom(z);
    setOffset(fit({ x: at.x - (at.x - offset.x) * k, y: at.y - (at.y - offset.y) * k }, s));
  };

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    setOffset(fit({ x: drag.current.ox + e.clientX - drag.current.px, y: drag.current.oy + e.clientY - drag.current.py }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onWheel = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    zoomTo(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const onKeyDown = (e) => {
    const step = e.shiftKey ? 20 : 5;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      setOffset(fit({ x: offset.x + moves[e.key][0], y: offset.y + moves[e.key][1] }));
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomTo(zoom + 0.1);
    } else if (e.key === "-") {
      e.preventDefault();
      zoomTo(zoom - 0.1);
    }
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        role="application"
        aria-label="Crop area: drag or use the arrow keys to move the image, + and − to zoom"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        className="relative touch-none select-none overflow-hidden rounded-xl bg-black/80 outline-none focus-visible:ring-3 focus-visible:ring-brand-primary/40 cursor-grab active:cursor-grabbing"
        style={{ width: size, height: size }}>
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={onLoad}
          className="pointer-events-none absolute left-0 top-0 max-w-none"
          style={{ width: shown.w, height: shown.h, transform: `translate(${offset.x}px, ${offset.y}px)`, opacity: natural ? 1 : 0 }}
        />
        {/* Rule-of-thirds guide and (optionally) the round avatar outline. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} className="border border-white/15" />
          ))}
        </div>
        {round && <div aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />}
      </div>
      <div className="flex w-full items-center gap-2" style={{ maxWidth: size }}>
        <button type="button" aria-label="Zoom out" onClick={() => zoomTo(zoom - 0.2)} disabled={zoom <= 1}
          className="rounded-md p-1 text-primary-text hover:bg-border-color/50 disabled:opacity-40 cursor-pointer">
          <MinusIcon />
        </button>
        <input type="range" aria-label="Zoom" min={1} max={MAX_ZOOM} step={0.01} value={zoom} onChange={(e) => zoomTo(Number(e.target.value))}
          className="flex-1 accent-[var(--brand-primary)]" />
        <button type="button" aria-label="Zoom in" onClick={() => zoomTo(zoom + 0.2)} disabled={zoom >= MAX_ZOOM}
          className="rounded-md p-1 text-primary-text hover:bg-border-color/50 disabled:opacity-40 cursor-pointer">
          <PlusIcon />
        </button>
      </div>
    </div>
  );
};

export default ImageCropper;
