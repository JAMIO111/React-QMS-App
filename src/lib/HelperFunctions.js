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

export function normalize(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function getStartOfWeek(date, weekStartsOn = 1) {
  const d = new Date(date);
  const day = d.getDay(); // 0 (Sun) - 6 (Sat)
  const diff = (day < weekStartsOn ? 7 : 0) + day - weekStartsOn;
  d.setDate(d.getDate() - diff);
  return normalize(d);
}

function getEndOfWeek(date, weekStartsOn = 1) {
  const start = getStartOfWeek(date, weekStartsOn);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return normalize(end);
}

function getStartOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getEndOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function getStartOfYear(date) {
  return new Date(date.getFullYear(), 0, 1);
}

function getEndOfYear(date) {
  return new Date(date.getFullYear(), 11, 31);
}

export const datePresets = [
  {
    label: "Last Week",
    range: () => {
      const startOfThisWeek = getStartOfWeek(new Date(), 1);
      const start = new Date(startOfThisWeek);
      start.setDate(start.getDate() - 7);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      return [normalize(start), normalize(end)];
    },
  },
  {
    label: "This Week",
    range: () => [getStartOfWeek(new Date(), 1), getEndOfWeek(new Date(), 1)],
  },
  {
    label: "Last Month",
    range: () => {
      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return [getStartOfMonth(lastMonth), getEndOfMonth(lastMonth)];
    },
  },
  {
    label: "This Month",
    range: () => [getStartOfMonth(new Date()), getEndOfMonth(new Date())],
  },
  {
    label: "Last Quarter",
    range: () => {
      const now = new Date();
      const currentQuarter = Math.floor(now.getMonth() / 3);
      const startMonth = ((currentQuarter - 1 + 4) % 4) * 3;
      const year =
        currentQuarter === 0 ? now.getFullYear() - 1 : now.getFullYear();
      const start = new Date(year, startMonth, 1);
      const end = new Date(year, startMonth + 3, 0);
      return [normalize(start), normalize(end)];
    },
  },
  {
    label: "This Quarter",
    range: () => {
      const now = new Date();
      const currentQuarter = Math.floor(now.getMonth() / 3);
      const startMonth = currentQuarter * 3;
      const start = new Date(now.getFullYear(), startMonth, 1);
      const end = new Date(now.getFullYear(), startMonth + 3, 0);
      return [normalize(start), normalize(end)];
    },
  },
  {
    label: "Last Year",
    prevoius: () => {
      const previousYear = new Date().getFullYear() - 2;
      return [new Date(previousYear, 0, 1), new Date(previousYear, 11, 31)];
    },
    range: () => {
      const lastYear = new Date().getFullYear() - 1;
      return [new Date(lastYear, 0, 1), new Date(lastYear, 11, 31)];
    },
  },
  {
    label: "This Year",
    prevoius: "Last Year",
    range: () => [getStartOfYear(new Date()), getEndOfYear(new Date())],
  },
  {
    label: "Rolling 7 Days",
    previous: "Previous 7 Days",
    range: () => {
      const end = normalize(new Date());
      const start = new Date(end);
      start.setDate(end.getDate() - 6);
      return [normalize(start), end];
    },
  },
  {
    label: "Rolling 30 Days",
    previous: "Previous 30 Days",
    range: () => {
      const end = normalize(new Date());
      const start = new Date(end);
      start.setDate(end.getDate() - 29);
      return [normalize(start), end];
    },
  },
  {
    label: "Rolling 90 Days",
    previous: "Previous 90 Days",
    range: () => {
      const end = normalize(new Date());
      const start = new Date(end);
      start.setDate(end.getDate() - 89);
      return [normalize(start), end];
    },
  },
];
