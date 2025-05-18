import { useSearchParams } from "react-router-dom";
import { useCallback } from "react";

export function useNCMFilters() {
  const [searchParams, setSearchParams] = useSearchParams();

  const search = searchParams.get("search") || "";
  const status = searchParams.get("status") || "";
  const failureMode = searchParams.get("failureMode") || "";

  const updateFilters = useCallback((newFilters) => {
    setSearchParams(
      (prevParams) => {
        const params = new URLSearchParams(prevParams);

        const currentFilters = {
          search: params.get("search") ?? "",
          failureMode: params.get("failureMode") ?? "",
          status: params.get("status") ?? "",
        };

        const filters =
          typeof newFilters === "function"
            ? newFilters(currentFilters)
            : { ...currentFilters, ...newFilters };

        if (filters.search) {
          params.set("search", filters.search);
        } else {
          params.delete("search");
        }
        if (filters.failureMode) {
          params.set("failureMode", filters.failureMode);
        } else {
          params.delete("failureMode");
        }
        if (filters.status) {
          params.set("status", filters.status);
        } else {
          params.delete("status");
        }

        return params;
      },
      {
        replace: true,
      }
    );
  }, []);

  return {
    search,
    status,
    failureMode,
    updateFilters,
  };
}
