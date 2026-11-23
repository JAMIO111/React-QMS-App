import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { CornerDownLeftIcon, HistoryIcon, LoaderCircleIcon, LogOutIcon, MoonStarIcon, SearchIcon, SunIcon, XIcon } from "@/components/icons";
import SlidingToggle from "../ui/SlidingToggle";
import { useCommandPalette } from "../../contexts/CommandPaletteProvider";
import { useCanSee } from "../../hooks/useQmsApi";
import { useModuleAccess } from "../../hooks/useSubscription";
import { useProductionSettings } from "../../hooks/useProduction";
import { SEARCH_MIN_LENGTH, useRecordSearch } from "../../hooks/useRecordSearch";
import useSignOut from "../../hooks/useSignOut";
import useTheme from "../../hooks/useTheme";
import {
  RECORD_KINDS,
  RECORD_KIND_ORDER,
  highlight,
  pageEntries,
  recentEntries,
  recordPath,
  routeActions,
  searchEntries,
  statusWords,
} from "../../lib/commandPalette";

/** How many rows each group shows in the "All" view before "Show all". */
const PREVIEW = { recent: 6, pages: 6, actions: 4 };
const RECORD_PREVIEW = 5;

/** The words typed, drawn marked inside a piece of text. */
const Marked = ({ text, query }) =>
  highlight(text, query).map((piece, i) =>
    piece.match ? (
      <mark key={i} className="rounded-sm bg-theme/20 px-px text-inherit">
        {piece.text}
      </mark>
    ) : (
      <span key={i}>{piece.text}</span>
    ),
  );

/**
 * The command palette: Ctrl/⌘+K from anywhere, or the button in the header search bar. Starts empty, shows what was opened lately and a few
 * actions; typing finds pages, actions and (from two letters) records, grouped, with a chip per kind and how many matched. ↑ ↓ move, ↵ chooses,
 * Esc closes and leaves the page behind it as it was (the header bar's own text, which filters the register on screen, is never touched here).
 */
const CommandPalette = () => {
  const navigate = useNavigate();
  const { closePalette, recents, remember, forget } = useCommandPalette();
  const canSee = useCanSee();
  const hasModule = useModuleAccess();
  const productionSettings = useProductionSettings();
  const [mode, setTheme] = useTheme();
  const [signOut] = useSignOut();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef(null);
  const list = useRef(null);
  const opener = useRef(typeof document === "undefined" ? null : document.activeElement);

  useEffect(() => {
    input.current?.focus();
    const from = opener.current;
    return () => {
      if (from instanceof HTMLElement && document.contains(from)) from.focus();
    };
  }, []);

  const typed = query.trim();
  const recordKind = RECORD_KIND_ORDER.includes(scope) ? scope : undefined;
  const wantsRecords = scope === "all" || !!recordKind;
  // The overview is always asked (it gives the chips their counts, whichever chip is chosen); the answer is cached, so the "All" view is instant.
  const overview = useRecordSearch({ q: query, limit: RECORD_PREVIEW });
  const detail = useRecordSearch({ q: query, kind: recordKind, limit: 25, enabled: !!recordKind });

  const allPages = pageEntries({ canSee, hasModule, productionSettings });
  const allActions = [
    ...routeActions({ canSee }),
    { id: "action:theme", group: "actions", label: mode === "dark" ? "Switch to light mode" : "Switch to dark mode", icon: mode === "dark" ? SunIcon : MoonStarIcon, keywords: "theme appearance dark light colour", run: () => setTheme(mode === "dark" ? "light" : "dark") },
    { id: "action:sign-out", group: "actions", label: "Sign out", icon: LogOutIcon, keywords: "log out logout", run: signOut },
  ];

  const pages = typed ? searchEntries(allPages, typed) : allPages;
  const actions = typed ? searchEntries(allActions, typed) : allActions;
  const recent = !typed ? recentEntries(recents) : [];
  const overviewGroups = overview.groups;
  const detailGroup = detail.groups.find((g) => g.kind === recordKind);

  // Groups for the chosen chip: { key, title, rows, total?, more? }.
  const entryRows = (items) => items.map((entry) => ({ type: "entry", id: entry.id, entry }));
  const recordRows = (group, items) => items.map((item) => ({ type: "record", id: `${group.kind}:${item.id}`, kind: group.kind, item }));
  const groups = [];
  const addEntryGroup = (key, title, items, limit) => {
    if (items.length === 0) return;
    const shown = limit && scope === "all" ? items.slice(0, limit) : items;
    groups.push({
      key,
      title,
      total: items.length,
      rows: [...entryRows(shown), ...(shown.length < items.length ? [{ type: "more", id: `more:${key}`, label: `Show all ${items.length}`, scope: key }] : [])],
    });
  };
  if (scope === "all") {
    addEntryGroup("recent", "Recently opened", recent, PREVIEW.recent);
    // With nothing typed and screens opened lately, those lead and the pages wait for a search or the Pages chip.
    if (typed || recent.length === 0) addEntryGroup("pages", "Pages", pages, PREVIEW.pages);
    addEntryGroup("actions", typed ? "Actions" : "Quick actions", actions, PREVIEW.actions);
    for (const group of overviewGroups) {
      groups.push({
        key: group.kind,
        title: RECORD_KINDS[group.kind].label,
        total: group.total,
        rows: [...recordRows(group, group.items), ...(group.total > group.items.length ? [{ type: "more", id: `more:${group.kind}`, label: `Show all ${group.total}`, scope: group.kind }] : [])],
      });
    }
  } else if (scope === "pages") addEntryGroup("pages", "Pages", pages);
  else if (scope === "actions") addEntryGroup("actions", "Actions", actions);
  else if (detailGroup) groups.push({ key: recordKind, title: RECORD_KINDS[recordKind].label, total: detailGroup.total, rows: recordRows(detailGroup, detailGroup.items) });

  const rows = groups.flatMap((g) => g.rows);
  const at = Math.min(active, Math.max(rows.length - 1, 0));

  useEffect(() => setActive(0), [query, scope]);
  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [at, rows.length]);

  const chips = [
    { value: "all", label: "All" },
    { value: "pages", label: "Pages", count: typed ? pages.length : undefined },
    { value: "actions", label: "Actions", count: typed ? actions.length : undefined },
    ...overviewGroups.map((g) => ({ value: g.kind, label: RECORD_KINDS[g.kind].label, count: g.total })),
  ];
  // A chosen kind that the new words no longer match stays offered (with no count) so the person can see why the list is empty.
  if (recordKind && !chips.some((c) => c.value === recordKind)) chips.push({ value: recordKind, label: RECORD_KINDS[recordKind].label, count: 0 });

  const choose = (row) => {
    if (!row) return;
    if (row.type === "more") {
      setScope(row.scope);
      input.current?.focus();
      return;
    }
    if (row.type === "record") {
      const to = recordPath(row.kind, row.item.id);
      remember({ path: to, label: [row.item.title, row.item.subtitle].filter(Boolean).join(" · "), hint: RECORD_KINDS[row.kind].singular });
      closePalette();
      navigate(to);
      return;
    }
    const { entry } = row;
    closePalette();
    if (entry.run) entry.run();
    else {
      if (entry.group !== "actions") remember({ path: entry.to, label: entry.label, hint: entry.hint });
      navigate(entry.to);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length === 0) return;
      setActive((at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length);
    } else if (e.key === "Enter" && e.target.tagName !== "BUTTON") {
      e.preventDefault();
      choose(rows[at]);
    }
  };

  const searching = (wantsRecords && overview.searching) || (!!recordKind && detail.searching);
  const nothing = rows.length === 0 && !searching;
  const rowId = (row) => `${listId}-${row.id}`;
  let index = -1;

  return createPortal(
    <div
      data-popover
      className="fixed inset-0 z-[9000] flex items-start justify-center bg-black/40 px-4 pt-[10vh] backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && closePalette()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
        className="flex max-h-[75vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border-color bg-secondary-bg shadow-2xl motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-150">
        <div className="shrink-0 flex items-center gap-3 border-b border-border-color px-4">
          <SearchIcon className="h-5 w-5 shrink-0 text-icon-color" />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={rows[at] ? rowId(rows[at]) : undefined}
            aria-label="Search pages, actions and records"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages, actions and records…"
            autoComplete="off"
            spellCheck={false}
            className="h-14 min-w-0 flex-1 bg-transparent text-base text-primary-text placeholder-muted focus:outline-none"
          />
          {searching && <LoaderCircleIcon className="h-4.5 w-4.5 shrink-0 animate-spin text-secondary-text motion-reduce:animate-none" aria-label="Searching" />}
          {query && (
            <button type="button" aria-label="Clear" onClick={() => { setQuery(""); input.current?.focus(); }} className="shrink-0 rounded-lg p-1.5 text-secondary-text hover:text-error-color">
              <XIcon className="h-4.5 w-4.5" />
            </button>
          )}
        </div>

        <div className="shrink-0 no-scrollbar overflow-x-auto border-b border-border-color px-4 py-2.5">
          <SlidingToggle
            ariaLabel="Show"
            options={chips}
            value={scope}
            onChange={(value) => {
              setScope(value);
              input.current?.focus();
            }}
            className="w-max"
          />
        </div>

        <div ref={list} id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-2">
          {groups.map((group) => (
            <section key={group.key} aria-label={group.title} className="pb-1">
              <div className="flex items-center justify-between px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-secondary-text">
                <span>{group.title}</span>
                {group.key === "recent" ? (
                  <button type="button" onClick={forget} className="font-normal normal-case tracking-normal hover:text-primary-text">
                    Clear
                  </button>
                ) : (
                  group.total > 0 && <span className="rounded-full bg-text-input-color px-2 py-0.5 text-[11px] font-medium tabular-nums">{group.total}</span>
                )}
              </div>
              {group.rows.map((row) => {
                index += 1;
                const selected = index === at;
                const mine = index;
                const common = {
                  id: rowId(row),
                  role: "option",
                  "aria-selected": selected,
                  onMouseMove: () => at !== mine && setActive(mine),
                  onClick: () => choose(row),
                };
                const base = clsx("flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-sm", selected ? "bg-theme/15 text-primary-text" : "text-primary-text");
                if (row.type === "more") {
                  return (
                    <div key={row.id} {...common} className={clsx(base, "text-secondary-text")}>
                      <span className="w-5 shrink-0" />
                      <span className="font-medium">{row.label}</span>
                    </div>
                  );
                }
                if (row.type === "record") {
                  const kind = RECORD_KINDS[row.kind];
                  const Icon = kind.icon;
                  return (
                    <div key={row.id} {...common} className={base}>
                      <Icon className="h-5 w-5 shrink-0 text-icon-color" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          <Marked text={row.item.title} query={typed} />
                        </span>
                        {row.item.subtitle && (
                          <span className="block truncate text-secondary-text">
                            <Marked text={row.item.subtitle} query={typed} />
                          </span>
                        )}
                      </span>
                      {row.item.status && <span className="shrink-0 rounded-full border border-border-color px-2 py-0.5 text-xs text-secondary-text">{statusWords(row.item.status)}</span>}
                      {selected && <CornerDownLeftIcon className="h-4 w-4 shrink-0 text-secondary-text" />}
                    </div>
                  );
                }
                const { entry } = row;
                const Icon = group.key === "recent" ? HistoryIcon : entry.icon;
                return (
                  <div key={row.id} {...common} className={base}>
                    {Icon ? <Icon className="h-5 w-5 shrink-0 text-icon-color" /> : <span className="w-5 shrink-0" />}
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">
                        <Marked text={entry.label} query={typed} />
                      </span>
                      {entry.hint && <span className="ml-2 text-secondary-text">{entry.hint}</span>}
                    </span>
                    {selected && <CornerDownLeftIcon className="h-4 w-4 shrink-0 text-secondary-text" />}
                  </div>
                );
              })}
            </section>
          ))}
          {nothing && (
            <p role="status" className="px-3 py-10 text-center text-sm text-secondary-text">
              {typed.length > 0 && typed.length < SEARCH_MIN_LENGTH
                ? "Keep typing to search records."
                : typed
                  ? `Nothing found for “${typed}”.`
                  : "Start typing to search."}
              {overview.failed && " Records could not be searched just now."}
            </p>
          )}
        </div>

        <div className="shrink-0 flex items-center gap-4 border-t border-border-color px-4 py-2 text-xs text-secondary-text">
          <span>
            <kbd className="rounded border border-border-color px-1">↑</kbd> <kbd className="rounded border border-border-color px-1">↓</kbd> navigate
          </span>
          <span>
            <kbd className="rounded border border-border-color px-1">↵</kbd> select
          </span>
          <span>
            <kbd className="rounded border border-border-color px-1">esc</kbd> close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default CommandPalette;
