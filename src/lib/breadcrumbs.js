import { useEffect, useSyncExternalStore } from "react";
import { AlarmClockIcon, FolderOpenIcon, ScanSearchIcon, SettingsIcon } from "@/components/icons";
import { menuStructure } from "../MenuStructure";

/**
 * Names for the parts of an address that are ids. A record page says what it is called ("ACME · Acme Metals", "SCAR-26-0004"); the breadcrumb shows that instead of the id.
 * `set(path, label, to?)` while the page is open, cleared when it closes. `to` sends the crumb somewhere other than its own address (a segment with no page of its own).
 */
let entries = new Map();
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l) => (listeners.add(l), () => listeners.delete(l));
const snapshot = () => entries;

export const setBreadcrumb = (path, label, to) => {
  entries = new Map(entries).set(path, { label, to });
  emit();
};
export const clearBreadcrumb = (path) => {
  if (!entries.has(path)) return;
  entries = new Map(entries);
  entries.delete(path);
  emit();
};

/** Names for the crumbs of the current page: `[{ path, label, to? }]`; a missing label is skipped (so the crumb waits, showing "…" for an id). */
export const useBreadcrumbNames = (items) => {
  const key = JSON.stringify(items.map((i) => [i.path, i.label ?? null, i.to ?? null]));
  useEffect(() => {
    const live = JSON.parse(key).filter(([, label, to]) => label || to);
    live.forEach(([path, label, to]) => setBreadcrumb(path, label, to));
    return () => live.forEach(([path]) => clearBreadcrumb(path));
  }, [key]);
};

export const useBreadcrumbEntries = () => useSyncExternalStore(subscribe, snapshot);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const looksLikeId = (segment) => UUID.test(segment);

/**
 * Each crumb carries the icon of the side-menu module its address belongs to: the menu entry (module or sub-page) whose path is the
 * longest start of the crumb's path. A path shared by two modules (Suppliers) takes the first. Addresses outside the menu: Settings,
 * the job hub (In-process inspection), else a folder.
 */
const MENU_ROOTS = [
  ...menuStructure.flatMap((m) => [m.path, ...m.subMenu.map((s) => s.path)].map((path) => ({ path: path.toLowerCase(), Icon: m.icon }))),
  { path: "/settings", Icon: SettingsIcon },
  { path: "/jobs", Icon: ScanSearchIcon },
  { path: "/reminders", Icon: AlarmClockIcon },
];

export const breadcrumbIcon = (path) => {
  const p = path.toLowerCase();
  let best = null;
  for (const r of MENU_ROOTS) {
    if ((p === r.path || p.startsWith(`${r.path}/`)) && (!best || r.path.length > best.path.length)) best = r;
  }
  return best?.Icon ?? FolderOpenIcon;
};
