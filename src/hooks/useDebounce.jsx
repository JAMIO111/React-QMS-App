import { useEffect, useState } from "react";

export const useDebouncedValue = (value, delay = 750) => {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handler = setTimeout(() => setDebounced(value), delay);

    return () => clearTimeout(handler); // Cancel on value change
  }, [value, delay]);

  return debounced;
};
