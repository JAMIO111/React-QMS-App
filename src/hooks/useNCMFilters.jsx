import { useSearchParams } from "react-router-dom";
import { useCallback } from "react";

export function useNCMFilters() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Read current values directly from the current searchParams
  const search = searchParams.get("search") || "";
  const status = searchParams.get("status") || "";
  const failureMode = searchParams.get("failureMode") || "";
  const subFailureMode = searchParams.get("subFailureMode") || "";

  // updateFilters uses only prevParams passed in setter callback!
  const updateFilters = useCallback(
    (newFilters) => {
      setSearchParams((prevParams) => {
        const params = new URLSearchParams();

        const filters =
          typeof newFilters === "function"
            ? newFilters({
                search: prevParams.get("search") || "",
                status: prevParams.get("status") || "",
                failureMode: prevParams.get("failureMode") || "",
                subFailureMode: prevParams.get("subFailureMode") || "",
                page: prevParams.get("page") || "1",
                pageSize: prevParams.get("pageSize") || "25",
              })
            : {
                search: prevParams.get("search") || "",
                status: prevParams.get("status") || "",
                failureMode: prevParams.get("failureMode") || "",
                subFailureMode: prevParams.get("subFailureMode") || "",
                page: prevParams.get("page") || "1",
                pageSize: prevParams.get("pageSize") || "25",
                ...newFilters,
              };

        Object.entries(filters).forEach(([key, value]) => {
          if (value !== undefined && value !== null && value !== "") {
            params.set(key, value);
          } else {
            params.delete(key);
          }
        });

        return params;
      });
    },
    [setSearchParams]
  );

  return {
    search,
    status,
    failureMode,
    subFailureMode,
    updateFilters,
  };
}
