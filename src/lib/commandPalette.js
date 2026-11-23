import {
  AlarmClockIcon,
  BoxesIcon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  FileTextIcon,
  GaugeIcon,
  ListTodoIcon,
  PlusIcon,
  ScanSearchIcon,
  TriangleAlertIcon,
  TruckIcon,
} from "@/components/icons";
import { menuStructure } from "../MenuStructure";
import SettingMenuStructure from "../SettingMenuStructure";
import { subMenuVisible } from "./production";
import { ncrPath } from "./ncr";
import { breadcrumbIcon, looksLikeId } from "./breadcrumbs";

/**
 * The header palette (opened with Ctrl/⌘+K): pages, actions and records you can jump to, and the ones you opened lately.
 * Everything here is plain data and functions so it is easy to test; the screen is `components/palette/CommandPalette.jsx`.
 */

/** The kinds of record the API's `GET /search` answers with, in the order the palette lists them. `path` is the screen that opens. */
export const RECORD_KINDS = {
  ncr: { label: "Non-conformances", singular: "Non-conformance", icon: TriangleAlertIcon, path: (id) => ncrPath(id) },
  capa: { label: "8Ds", singular: "8D", icon: ClipboardListIcon, path: (id) => `/CAPA/${id}` },
  part: { label: "Parts", singular: "Part", icon: BoxesIcon, path: (id) => `/Parts/${id}` },
  supplier: { label: "Suppliers", singular: "Supplier", icon: TruckIcon, path: (id) => `/Suppliers/${id}` },
  gauge: { label: "Gauges", singular: "Gauge", icon: GaugeIcon, path: (id) => `/Calibration/Gauges/${id}` },
  inspection: { label: "Inspections", singular: "Inspection", icon: ScanSearchIcon, path: (id) => `/Inspections/${id}` },
  document: { label: "Documents", singular: "Document", icon: FileTextIcon, path: (id) => `/Documentation/Documents/${id}` },
};
export const RECORD_KIND_ORDER = Object.keys(RECORD_KINDS);
export const recordPath = (kind, id) => RECORD_KINDS[kind]?.path(id) ?? "/";

/** "awaiting_closure" → "Awaiting closure" */
export const statusWords = (status) => {
  const words = String(status ?? "").replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
};

/**
 * Every page of the side menu and of Settings the person may see (the menu's own rules: permission, subscription module, organisation
 * setting). A module with one page is listed once; a module's own dashboard reads "<Module> dashboard".
 */
export const pageEntries = ({ canSee, hasModule = () => true, productionSettings } = {}) => {
  const out = [];
  for (const module of menuStructure) {
    if (!canSee(module.permission) || !hasModule(module.module)) continue;
    const subs = (module.subMenu ?? []).filter((s) => subMenuVisible(s, canSee, productionSettings));
    if (subs.length === 0) {
      out.push({ id: `page:${module.path}`, group: "pages", label: module.name, hint: null, icon: module.icon, to: module.path });
      continue;
    }
    for (const sub of subs) {
      out.push({
        id: `page:${sub.path}`,
        group: "pages",
        label: sub.name === "Dashboard" ? `${module.name} dashboard` : sub.name,
        hint: module.name,
        icon: module.icon,
        to: sub.path,
      });
    }
  }
  for (const item of SettingMenuStructure) {
    if (!canSee(item.permission)) continue;
    out.push({ id: `page:/Settings/${item.path}`, group: "pages", label: item.name, hint: "Settings", icon: item.icon, to: `/Settings/${item.path}`, keywords: "settings preferences" });
  }
  return out;
};

/** Things to do that are a screen away; `permission` is the right the screen needs. (Actions that act on the spot are added by the palette.) */
const ROUTE_ACTIONS = [
  { id: "new-ncr", icon: PlusIcon, label: "New non-conformance", to: "/Non-Conformance/Register/new", permission: "ncr.create", keywords: "raise nc ncr report problem" },
  { id: "start-inspection", icon: ScanSearchIcon, label: "Start an inspection", to: "/Inspections/new", permission: "inspection.record", keywords: "job first off check" },
  { id: "new-audit", icon: ClipboardCheckIcon, label: "Define a new audit", to: "/Audits/Templates/new", permission: "audits.manage", keywords: "audit template checklist" },
  { id: "new-quality-alert", icon: PlusIcon, label: "New quality alert", to: "/Documentation/Quality-Alerts/new", permission: "documentation.manage", keywords: "alert warn" },
  { id: "my-reminders", icon: AlarmClockIcon, label: "My reminders", to: "/Reminders", keywords: "due overdue digest" },
  { id: "my-tasks", icon: ListTodoIcon, label: "My tasks", to: "/Tasks", keywords: "to do todo" },
];

export const routeActions = ({ canSee }) =>
  ROUTE_ACTIONS.filter((a) => canSee(a.permission)).map((a) => ({
    id: `action:${a.id}`,
    group: "actions",
    label: a.label,
    hint: null,
    icon: a.icon,
    to: a.to,
    keywords: a.keywords,
  }));

// ── matching ─────────────────────────────────────────────────────────────────────────────────────────────────

const fold = (text) => String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export const tokens = (query) => fold(query).split(/\s+/).filter(Boolean);

/**
 * How well an entry matches the words typed, or `null` when it does not match: every word must be found in the label, the module's name or
 * the entry's keywords. Lower is better: a label that starts with the word, then a word that starts a word of the label, then anywhere in the
 * label, then only in the module's name or keywords.
 */
export const scoreEntry = (entry, query) => {
  const words = tokens(query);
  if (words.length === 0) return 0;
  const label = fold(entry.label);
  const rest = fold(`${entry.hint ?? ""} ${entry.keywords ?? ""}`);
  let score = 0;
  for (const word of words) {
    if (label.startsWith(word)) score += 0;
    else if (label.split(/[^a-z0-9]+/).some((w) => w.startsWith(word))) score += 1;
    else if (label.includes(word)) score += 2;
    else if (rest.includes(word)) score += 3;
    else return null;
  }
  return score;
};

/** The entries that match, best first, keeping the menu's order among equals. */
export const searchEntries = (entries, query) =>
  entries
    .map((entry, index) => ({ entry, index, score: scoreEntry(entry, query) }))
    .filter((r) => r.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((r) => r.entry);

/** The text cut into `{ text, match }` pieces so the words typed can be drawn marked (the pieces always join back into the text). */
export const highlight = (text, query) => {
  const source = String(text ?? "");
  const words = tokens(query);
  if (words.length === 0 || source === "") return [{ text: source, match: false }];
  // Folding can change the length of a character (rare); fall back to no marks rather than mark the wrong letters.
  const folded = fold(source);
  if (folded.length !== source.length) return [{ text: source, match: false }];
  const marked = new Array(source.length).fill(false);
  for (const word of words) {
    for (let at = folded.indexOf(word); at !== -1; at = folded.indexOf(word, at + word.length)) {
      for (let i = at; i < at + word.length; i += 1) marked[i] = true;
    }
  }
  const pieces = [];
  for (let i = 0; i < source.length; i += 1) {
    const last = pieces[pieces.length - 1];
    if (last && last.match === marked[i]) last.text += source[i];
    else pieces.push({ text: source[i], match: marked[i] });
  }
  return pieces;
};

// ── recently opened ──────────────────────────────────────────────────────────────────────────────────────────

export const RECENT_LIMIT = 8;
export const recentKey = (userId, organisationId) => `fortress.recent.${userId}.${organisationId}`;

export const loadRecents = (key) => {
  try {
    const list = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(list) ? list.filter((r) => r && typeof r.path === "string" && typeof r.label === "string").slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
};

/** Puts a screen first in the list (once: the same address replaces its earlier entry) and keeps the newest eight. Returns the new list. */
export const addRecent = (key, item) => {
  const next = [{ path: item.path, label: item.label, hint: item.hint ?? null }, ...loadRecents(key).filter((r) => r.path !== item.path)].slice(0, RECENT_LIMIT);
  try {
    window.localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Storage can be blocked (private windows); the list then lives only as long as the page.
  }
  return next;
};

export const clearRecents = (key) => {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // nothing stored, nothing to clear
  }
};

/** A record's own page is an address ending in an id; those are what "recently opened" remembers beyond what was picked in the palette. */
export const isRecordAddress = (pathname) => looksLikeId(pathname.split("/").filter(Boolean).pop() ?? "");

export const recentEntries = (recents) =>
  recents.map((r) => ({ id: `recent:${r.path}`, group: "recent", label: r.label, hint: r.hint, icon: breadcrumbIcon(r.path), to: r.path }));

/** Ctrl on Windows and Linux, ⌘ on Apple devices. */
export const isApplePlatform = () => typeof navigator !== "undefined" && /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");
