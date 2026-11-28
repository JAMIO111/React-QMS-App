import { useState } from "react";
import { useAvatarUrl } from "@/hooks/useSignedAvatarURL";
import { initialsOf } from "@/lib/employees";

const SIZES = {
  xs: "h-5 w-5 text-[9px]",
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
};

/**
 * A person as a small circle: their profile picture when `path` names one in the avatars bucket and it can be read, else their initials on
 * a tint of the theme colour (`inverted` for a highlighted, theme-coloured row). Decorative (the name is always written beside it), so it is hidden from screen readers.
 */
const Initials = ({ name, shape, inverted }) => (
  <span aria-hidden="true" data-initials className={`${shape} flex items-center justify-center font-semibold ${inverted ? "bg-white/25 text-white" : "bg-brand-primary/15 text-brand-primary"}`}>
    {initialsOf(name)}
  </span>
);

// Only someone with a picture asks for a signed link; everyone else is initials straight away.
const Photo = ({ name, path, shape, inverted }) => {
  const url = useAvatarUrl(path);
  const [broken, setBroken] = useState(null);
  if (url && broken !== url)
    return <img src={url} alt="" aria-hidden="true" onError={() => setBroken(url)} className={`${shape} object-cover`} />;
  return <Initials name={name} shape={shape} inverted={inverted} />;
};

const PersonAvatar = ({ name, path, size = "sm", inverted = false, className = "" }) => {
  const shape = `${SIZES[size] ?? SIZES.sm} shrink-0 rounded-full ${className}`;
  return path ? <Photo name={name} path={path} shape={shape} inverted={inverted} /> : <Initials name={name} shape={shape} inverted={inverted} />;
};

export default PersonAvatar;
