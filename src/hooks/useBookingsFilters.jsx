import { useSearchParams } from "react-router-dom";
import { useCallback } from "react";

export function useBookingsFilters() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Read current values directly from the current searchParams
  const search = searchParams.get("search") || "";
  const leadGuest = searchParams.get("leadGuest") || "";
  const bookingRef = searchParams.get("bookingRef") || "";
  const property = searchParams.get("property") || "";
  const managementPackage = searchParams.get("package") || "";
  const type = searchParams.get("type") || "";

  // updateFilters uses only prevParams passed in setter callback!
  const updateFilters = useCallback(
    (newFilters) => {
      setSearchParams((prevParams) => {
        const params = new URLSearchParams();

        const filters =
          typeof newFilters === "function"
            ? newFilters({
                search: prevParams.get("search") || "",
                leadGuest: prevParams.get("leadGuest") || "",
                bookingRef: prevParams.get("bookingRef") || "",
                property: prevParams.get("property") || "",
                managementPackage: prevParams.get("package") || "",
                type: prevParams.get("type") || "",
                page: prevParams.get("page") || "1",
                pageSize: prevParams.get("pageSize") || "25",
              })
            : {
                search: prevParams.get("search") || "",
                leadGuest: prevParams.get("leadGuest") || "",
                bookingRef: prevParams.get("bookingRef") || "",
                property: prevParams.get("property") || "",
                managementPackage: prevParams.get("package") || "",
                type: prevParams.get("type") || "",
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
    leadGuest,
    bookingRef,
    property,
    managementPackage,
    type,
    updateFilters,
  };
}
