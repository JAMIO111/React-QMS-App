import { AlarmClockIcon, CircleHelpIcon, LogOutIcon, MoonStarIcon, SettingsIcon, SunIcon } from "@/components/icons";
import DropdownMenu from "./ui/DropdownMenu";
import { useUser } from "../contexts/UserProvider";
import useSignedAvatarUrl from "../hooks/useSignedAvatarURL";
import useSignOut from "../hooks/useSignOut";
import useTheme from "../hooks/useTheme";
import { HELP_URL } from "../lib/help";

/** The profile picture in the header: name and email, Settings, Help, dark mode and Logout in the shared dropdown menu. */
const ProfileMenu = () => {
  const { profile } = useUser();
  const [mode, setTheme] = useTheme();
  const [signOutNow, signingOut] = useSignOut();
  const { signedUrl: avatarUrl } = useSignedAvatarUrl(profile?.avatar_path);

  const name = [profile?.first_name, profile?.surname].filter(Boolean).join(" ") || profile?.email || "User";
  const dark = mode === "dark";

  return (
    <DropdownMenu
      label="Account menu"
      header={
        <>
          <p className="truncate font-semibold text-primary-text">{name}</p>
          {profile?.email && name !== profile.email && <p className="truncate text-sm text-secondary-text">{profile.email}</p>}
        </>
      }
      items={[
        { label: "My reminders", icon: AlarmClockIcon, to: "/Reminders" },
        { label: "Settings", icon: SettingsIcon, to: "/Settings" },
        HELP_URL
          ? { label: "Help", icon: CircleHelpIcon, href: HELP_URL }
          : { label: "Help", icon: CircleHelpIcon, disabled: true, hint: "Not set up yet" },
        { label: "Dark mode", icon: dark ? MoonStarIcon : SunIcon, checked: dark, onSelect: () => setTheme(dark ? "light" : "dark") },
        { separator: true },
        { label: signingOut ? "Logging out…" : "Logout", icon: LogOutIcon, tone: "danger", disabled: signingOut, onSelect: signOutNow },
      ]}
      trigger={(props, { open }) => (
        <button
          {...props}
          aria-label="Account menu"
          title="Account menu"
          className={`rounded-lg cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-brand-primary ${open ? "ring-2 ring-brand-primary" : ""}`}>
          <img
            className="rounded-lg border-1 border-border-color w-10 h-10 object-cover"
            src={avatarUrl || "/fortress-qms.png"}
            alt=""
          />
        </button>
      )}
    />
  );
};

export default ProfileMenu;
