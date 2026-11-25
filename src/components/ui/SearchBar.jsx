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
    <div className="flex w-1/3 p-2 relative items-center ">
      <SearchIcon className="pointer-events-none absolute left-5 h-4.5 w-4.5 text-icon-color" />
      <input
        id="Global Search Bar"
        name="search-bar"
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        className="w-full h-9.5 text-sm shadow-s hover:shadow-m bg-text-input-color text-primary-text placeholder-muted hover:border-border-dark-color focus:border-blue-300 focus:ring focus:ring-blue-200 focus:outline-none rounded-lg pl-12 pr-28"
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
          className="flex cursor-pointer items-center gap-1 rounded-md border border-border-color px-1.5 py-0.5 text-xs text-secondary-text hover:text-primary-text">
          <kbd className="font-sans">{isApplePlatform() ? "⌘ K" : "Ctrl K"}</kbd>
        </button>
      </div>
    </div>
  );
};

export default SearchBar;
