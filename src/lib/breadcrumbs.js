import { useEffect, useSyncExternalStore } from "react";

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
