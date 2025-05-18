import { createContext, useContext, useState, useEffect } from "react";
import { useDebouncedValue } from "../hooks/useDebounce";
import { useSearchParams } from "react-router-dom";

const SearchContext = createContext();

export const SearchProvider = ({ children }) => {
  const [searchParams] = useSearchParams();
  const urlSearch = searchParams.get("search") || "";
  const [searchTerm, setSearchTerm] = useState(urlSearch);

  useEffect(() => {
    setSearchTerm(urlSearch);
  }, [urlSearch]);

  const debouncedSearchTerm = useDebouncedValue(searchTerm, 750);

  return (
    <SearchContext.Provider
      value={{ searchTerm, setSearchTerm, debouncedSearchTerm }}>
      {children}
    </SearchContext.Provider>
  );
};

export const useGlobalSearch = () => useContext(SearchContext);
