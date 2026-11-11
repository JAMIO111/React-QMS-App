/**
 * Pages are loaded on demand from files with hashed names, and every deployment renames them. A tab opened before a deployment asks for
 * files that are gone and the import fails. A reload picks up the new names, so that is what the app does (once), instead of showing an error.
 */
const CHUNK_MESSAGES =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading (CSS )?chunk [\w-]+ failed/i;

/** Whether an error is a page file that could not be loaded (Chrome, Firefox and Safari word it differently). */
export const isChunkLoadError = (error) => CHUNK_MESSAGES.test(String(error?.message ?? error ?? "")) || error?.name === "ChunkLoadError";

const KEY = "fortress:chunk-reload";
const WINDOW_MS = 30_000;

/**
 * True when the page should reload now for a failed page file: at most once in thirty seconds, so a file that is really missing can never
 * cause a reload loop (the second failure shows the error instead). Where storage is blocked it allows no reload at all.
 */
export const shouldReloadForChunkError = (now = Date.now(), storage = typeof sessionStorage === "undefined" ? null : sessionStorage) => {
  try {
    const last = Number(storage?.getItem(KEY) ?? 0);
    if (!storage || (last && now - last < WINDOW_MS)) return false;
    storage.setItem(KEY, String(now));
    return true;
  } catch {
    return false;
  }
};

/** A seam for tests: the one place that reloads the page. */
export const reloadPage = () => window.location.reload();
