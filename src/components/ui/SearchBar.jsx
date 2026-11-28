import { SearchIcon, XIcon } from "@/components/icons";
import { useGlobalSearch } from "../../contexts/SearchProvider";
import { useCommandPalette } from "../../contexts/CommandPaletteProvider";
import { isApplePlatform } from "../../lib/commandPalette";

/**
 * The header search. Closed (this bar), what is typed filters the register or list on screen. The button on its right, or Ctrl/⌘+K, opens the
 * command palette (pages, actions and records), which starts empty and leaves this text alone.
 */
const SearchBar = () => {
  const { searchTerm, setSearchTerm } = useGlobalSearch();
  const { openPalette } = useCommandPalette();

  return (
    <div className="relative flex w-full min-w-0 flex-1 items-center p-2 md:w-1/2 md:flex-none lg:w-1/3">
      <SearchIcon className="pointer-events-none absolute left-5 h-4.5 w-4.5 text-icon-color" />
      <input
        id="Global Search Bar"
        name="search-bar"
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        className="w-full h-9.5 text-sm shadow-s hover:shadow-m bg-text-input-color text-primary-text placeholder-muted hover:border-border-dark-color focus:border-blue-300 focus:ring focus:ring-blue-200 focus:outline-none rounded-lg pl-12 pr-28 pointer-coarse:h-11 pointer-coarse:pr-20"
        type="text"
        placeholder="Filter this page…"
      />
      <div className="absolute right-4 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {searchTerm.length !== 0 && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setSearchTerm("");
            }}
            className="text-secondary-text rounded-lg p-1.5 hover:text-error-color cursor-pointer">
            <XIcon className="h-4.5 w-4.5" />
          </button>
        )}
        <button
          type="button"
          aria-label="Open the command palette"
          title="Search pages, actions and records"
          onClick={openPalette}
          className="flex cursor-pointer items-center gap-1 rounded-md border border-border-color px-1.5 py-0.5 pointer-coarse:h-9 pointer-coarse:px-3 pointer-coarse:text-sm text-xs text-secondary-text hover:text-primary-text">
          {/* A keyboard shortcut means nothing on a touch screen: it says what the button does instead. */}
          <kbd className="font-sans pointer-coarse:hidden">{isApplePlatform() ? "⌘ K" : "Ctrl K"}</kbd>
          <span className="hidden pointer-coarse:inline">Find</span>
        </button>
      </div>
    </div>
  );
};

export default SearchBar;
