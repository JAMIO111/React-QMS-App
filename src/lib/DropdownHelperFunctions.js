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
