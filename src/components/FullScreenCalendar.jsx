import { useState, useMemo } from "react";
import CTAButton from "./CTAButton";

const tasksData = {
  "2025-08-04": [
    { id: 1, title: "Team meeting", time: "10:00 AM" },
    { id: 2, title: "Code review", time: "2:00 PM" },
    { id: 3, title: "Write docs", time: "3:00 PM" },
    { id: 4, title: "Customer call", time: "4:00 PM" },
    { id: 5, title: "Planning session", time: "5:00 PM" },
    { id: 6, title: "Nightly backup", time: "10:00 PM" },
    { id: 7, title: "System checks", time: "11:00 PM" },
  ],
  "2025-09-09": [
    { id: 8, title: "Write documentation", time: "1:00 PM" },
    { id: 9, title: "Deploy new version", time: "3:00 PM" },
    { id: 10, title: "Team retrospective", time: "4:00 PM" },
  ],
};

export default function FullScreenCalendar() {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(null);

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const firstDayOfMonth = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const calendarDays = useMemo(() => {
    const days = [];

    // Leading blanks
    for (let i = 0; i < firstDayOfMonth; i++) days.push(null);

    // Actual days
    for (let d = 1; d <= daysInMonth; d++) days.push(new Date(year, month, d));

    // Trailing blanks
    const totalCells = Math.ceil(days.length / 7) * 7;
    while (days.length < totalCells) days.push(null);

    return days;
  }, [year, month, firstDayOfMonth, daysInMonth]);

  const prevMonth = () => setCurrentMonth(new Date(year, month - 1, 1));
  const nextMonth = () => setCurrentMonth(new Date(year, month + 1, 1));
  const handleDayClick = (date) => setSelectedDate(date);

  const totalDays = calendarDays.length;
  const numRows = Math.ceil(totalDays / 7);

  const formattedDate = selectedDate
    ? selectedDate.toISOString().split("T")[0]
    : null;
  const tasks = formattedDate ? tasksData[formattedDate] || [] : [];

  return (
    <div className="h-full bg-primary-bg flex items-center justify-center">
      <div className=" shadow-m h-full w-full flex flex-col overflow-hidden">
        {/* Header */}
        <header className="p-3 border-border-color flex justify-between items-center bg-tertiary-bg text-primary-text">
          <CTAButton
            width="w-24"
            type="main"
            text="Prev"
            callbackFn={prevMonth}
          />
          <h1 className="text-2xl font-bold">
            {currentMonth.toLocaleString("default", {
              month: "long",
              year: "numeric",
            })}
          </h1>
          <CTAButton
            width="w-24"
            type="main"
            text="Next"
            callbackFn={nextMonth}
          />
        </header>

        {/* Calendar Grid */}
        <main
          className="flex-1 border-border-color border bg-secondary-bg grid grid-cols-7 overflow-hidden"
          style={{
            gridTemplateRows: `auto repeat(${numRows}, 1fr)`,
          }}>
          {/* Weekday headers */}
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
            <div
              key={d}
              className={`text-center border-r border-t border-border-color font-semibold text-secondary-text uppercase py-2 ${
                i === 0 ? "" : ""
              }`}>
              {d}
            </div>
          ))}

          {/* Day cells */}
          {calendarDays.map((date, idx) =>
            date ? (
              <div
                key={idx}
                onClick={() => handleDayClick(date)}
                className={`relative border border-border-color flex flex-col cursor-pointer bg-tertiary-bg transition-all duration-200 hover:shadow-md hover:bg-cta-color/10 min-h-0 ${
                  formattedDate === date.toISOString().split("T")[0]
                    ? "bg-blue-100 border-blue-400 shadow-md"
                    : ""
                }`}>
                <span className="font-semibold text-secondary-text absolute top-1 left-2 z-10">
                  {date.getDate()}
                </span>
                <span className="text-xs text-error-color/70 absolute top-1.75 right-2 z-10">
                  {tasksData[date.toISOString().split("T")[0]]
                    ? tasksData[date.toISOString().split("T")[0]].length +
                      " Items"
                    : null}
                </span>

                {/* FIXED HEIGHT SCROLL AREA */}
                <div className="mt-6 p-2 overflow-y-auto [&::-webkit-scrollbar]:hidden flex-1 min-h-0">
                  {tasksData[date.toISOString().split("T")[0]] && (
                    <div className="flex flex-col gap-1.5">
                      {tasksData[date.toISOString().split("T")[0]].map(
                        (task) => (
                          <div
                            key={task.id}
                            className="flex py-0.5 px-2 bg-secondary-bg rounded-md shadow-s gap-3 items-center justify-start flex-shrink-0">
                            <span className="w-2 h-2 bg-blue-500 rounded-full flex-shrink-0"></span>
                            <p className="text-secondary-text text-xs truncate">
                              {task.title}
                            </p>
                          </div>
                        )
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div
                key={idx}
                className="border border-border-color bg-tertiary-bg"></div>
            )
          )}
        </main>

        {/* Popover */}
        {selectedDate && (
          <div className="fixed inset-0 flex items-center justify-center bg-black/40 z-50">
            <div className="bg-white rounded-xl p-6 w-96 shadow-xl relative animate-fadeIn max-h-[80vh] overflow-y-auto">
              <button
                onClick={() => setSelectedDate(null)}
                className="absolute top-3 right-3 text-gray-500 hover:text-gray-800 text-xl font-bold transition">
                ×
              </button>
              <h2 className="text-xl font-semibold mb-4 text-gray-700">
                Tasks for {selectedDate.toDateString()}
              </h2>
              {tasks.length ? (
                tasks.map((task) => (
                  <div
                    key={task.id}
                    className="border-b last:border-none py-2 flex flex-col">
                    <span className="font-medium text-gray-800">
                      {task.title}
                    </span>
                    <span className="text-sm text-gray-500">{task.time}</span>
                  </div>
                ))
              ) : (
                <div className="text-gray-400 text-center py-4">
                  No tasks for this day
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
