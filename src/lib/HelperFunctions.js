export const handleKeyDown = (e) => {
  if (!isOpen) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    setHighlightedIndex((prev) => {
      const nextIndex = prev === filteredOptions.length - 1 ? 0 : prev + 1;
      scrollIntoViewIfNeeded(nextIndex);
      return nextIndex;
    });
  } else if (e.key === "ArrowUp") {
    e.preventDefault();

    setHighlightedIndex((prev) => {
      const nextIndex = prev === 0 ? filteredOptions.length - 1 : prev - 1;
      scrollIntoViewIfNeeded(nextIndex);
      return nextIndex;
    });
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (filteredOptions[highlightedIndex]) {
      handleSelect(filteredOptions[highlightedIndex]);
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    setIsOpen(false);
  }
};

export const scrollIntoViewIfNeeded = (index) => {
  const item = itemRefs.current[index];
  if (item) {
    item.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }
};

export const normalizeFetchedData = (data) => {
  const normalized = {};

  for (const key in data) {
    const value = data[key];
    if (value === null) {
      normalized[key] = undefined;
    } else if (Array.isArray(value)) {
      // Recursively normalize arrays of objects (e.g., KeyCodes)
      normalized[key] = value.map((item) =>
        typeof item === "object" && item !== null
          ? normalizeFetchedData(item)
          : item
      );
    } else if (typeof value === "object") {
      normalized[key] = normalizeFetchedData(value);
    } else {
      normalized[key] = value;
    }
  }

  return normalized;
};

export const getGreeting = () => {
  const hour = new Date().getHours();

  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
};
