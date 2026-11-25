# Header command palette

Agreed with the owner 2026-11-23. No migration; information only (it never changes a record).

## What it is

The header search bar has two modes.

* **Closed** (the bar as it always was): what is typed filters the register or list on screen through `useGlobalSearch`. Nothing about that changed apart from the placeholder ("Filter this page…").
* **Open** (Ctrl/⌘+K from anywhere, or the `Ctrl K` button inside the bar): a command palette over the page. It starts empty, never reads or changes the bar's own text, and Esc returns to the bar with the page filter exactly as it was.

## What the palette finds

* **Pages**: every page of the side menu and of Settings the person may see (the menu's own rules: permission, subscription module, organisation setting), built from `MenuStructure.js` and `SettingMenuStructure.js`, so a new menu entry appears in the palette by itself.
* **Actions**: screens a click away (New non-conformance, Start an inspection, Define a new audit, New quality alert, My reminders, My tasks; each needs the right it needs) and actions on the spot (switch dark / light mode, sign out). A new route action is one line in `ROUTE_ACTIONS` (`lib/commandPalette.js`).
* **Records** (from two letters): `GET /search?q&kind&limit` (`api/src/search/search.service.ts`) answers per kind with `total` and the first rows. Kinds: non-conformances, 8Ds, parts, suppliers, gauges, inspections, documents. **A kind the person may not read is absent from the answer (never an empty list)**, the same permission checks the home dashboard makes; rows are read as the caller, so row-level security still decides what comes back; `%` and `_` typed mean themselves. A new kind needs: its finder in `FINDERS` and its permission in `SearchService.find`, its entry in `SEARCH_KINDS` and `RECORD_KINDS` (label, icon, screen).
* **Recently opened**: shown when the box is empty. Kept **in this browser** per person and organisation (`localStorage`, `fortress.recent.<user>.<organisation>`, newest eight, one entry per address): filled by what is chosen in the palette and by every record page that names itself for the breadcrumb (`CommandPaletteProvider`). It is a convenience, not a record, so there is no table; it does not follow the person to another device.

## The screen

Chips (All, Pages, Actions and one per kind of record that matched, each with its count) above grouped results with the words typed marked. "Show all N" on a group switches to that kind's chip (up to 25 rows). ↑ ↓ move, ↵ chooses, Esc closes; the input is a combobox with `aria-activedescendant`. Code: `components/palette/CommandPalette.jsx`, `contexts/CommandPaletteProvider.jsx` (open state, shortcut, recents), `hooks/useRecordSearch.js`, `lib/commandPalette.js` (entries, matching, highlighting, recents), `ui/SearchBar.jsx` (the button).

## Tests

`lib/commandPalette.test.js`, `components/palette/CommandPalette.test.jsx`, `api/test/search.e2e-spec.ts` (+ the tenancy sweep, which asks `GET /search?q=00` as an owner of another organisation and must find nothing of the first one's).

## Not built

Searching records by every field (reference, number, name and title only), more kinds (risks, SCARs, production orders, audits, customers, machines are one finder each), recent items that follow the person across devices (needs a table), saved searches, running a register's filters from the palette.
