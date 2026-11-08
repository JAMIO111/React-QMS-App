import { useEffect, useState } from "react";

/** Search term typed into a combo box, debounced for the server. */
export const useDebouncedSearch = (delay = 300) => {
  const [term, setTerm] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(term.trim()), delay);
    return () => clearTimeout(t);
  }, [term, delay]);
  return [q, setTerm];
};
