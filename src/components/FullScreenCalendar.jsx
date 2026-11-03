import { useState, useMemo } from "react";
import CTAButton from "./CTAButton";
import { useModal } from "@/contexts/ModalContext";
import DailyCalendarItems from "@components/DailyCalendarItems";
import SlidingSelectorGeneric from "./ui/SlidingSelectorGeneric";
import { useCalendarItems } from "@/hooks/useCalendarItems";
import { useJobs } from "@/hooks/useJobs";
import { useMeetings } from "@/hooks/useMeetings";

export default function FullScreenCalendar() {
  const [view, setView] = useState("Weekly");
  const { data: calendarItems, isLoading } = useCalendarItems(
    new Date("2025-08-01"),
    new Date("2025-12-30")
  );

  const { jobs, isLoading: jobsLoading } = useJobs(
    new Date("2025-08-01"),
    new Date("2025-12-30")
  );

  const { data: meetings, isLoading: meetingsLoading } = useMeetings(
    new Date("2025-08-01"),
    new Date("2025-12-30")
  );

  console.log("Calendar Items:", calendarItems);
  console.log("Jobs for Calendar:", jobs);
  console.log("Meetings for Calendar:", meetings);

  const { openModal } = useModal();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(null);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  // --- MONTHLY DAYS ---
  const firstDayOfMonth = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const calendarDays = useMemo(() => {
    const days = [];
    for (let i = 0; i < firstDayOfMonth; i++) days.push(null);
    for (let d = 1; d <= daysInMonth; d++) days.push(new Date(year, month, d));
    const totalCells = Math.ceil(days.length / 7) * 7;
    while (days.length < totalCells) days.push(null);
    return days;
  }, [year, month, firstDayOfMonth, daysInMonth]);

  // --- WEEKLY DAYS ---
  const startOfWeek = useMemo(() => {
    const d = new Date(currentDate);
    const day = d.getDay();
    d.setDate(d.getDate() - day); // Sunday-start week
    return d;
  }, [currentDate]);

  const weeklyDays = useMemo(() => {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const newDate = new Date(startOfWeek);
      newDate.setDate(startOfWeek.getDate() + i);
      days.push(newDate);
    }
    return days;
  }, [startOfWeek]);

  // --- NAVIGATION ---
  const prevMonth = () => setCurrentDate(new Date(year, month - 1, 1));
  const nextMonth = () => setCurrentDate(new Date(year, month + 1, 1));
  const prevWeek = () =>
    setCurrentDate((d) => new Date(d.setDate(d.getDate() - 7)));
  const nextWeek = () =>
    setCurrentDate((d) => new Date(d.setDate(d.getDate() + 7)));

  // --- DAILY MODAL ---
  const formattedDate = selectedDate
    ? selectedDate.toISOString().split("T")[0]
    : null;
  const tasks = formattedDate ? tasksData[formattedDate] || [] : [];

  const openDailyItemsModal = (date) => {
    openModal({
      title: `Calendar Items for ${date.toLocaleDateString("en-GB", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })}`,
      content: <DailyCalendarItems date={date} tasks={tasks} />,
    });
  };

  // --- SHARED DAY CELL RENDERER ---
  const renderDayCell = (date, idx) => {
    if (!date)
      return (
        <div
          key={idx}
          className="border border-border-color bg-secondary-bg cursor-default"></div>
      );

    const dateKey = `${date.getFullYear()}-${(date.getMonth() + 1)
      .toString()
      .padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}`;
    const itemsForDay = calendarItems?.[dateKey] || [];
    const jobsForDay = itemsForDay.filter((item) => item.type === "job");
    const meetingsForDay = itemsForDay.filter(
      (item) => item.type === "meeting"
    );

    return (
      <div
        key={idx}
        onClick={() => openDailyItemsModal(date)}
        className={`relative border border-border-color flex flex-col cursor-pointer
        transition-all duration-200 hover:shadow-md hover:bg-cta-color/5 
        ${
          formattedDate === dateKey
            ? "bg-blue-100 border-blue-400 shadow-md"
            : ""
        }
        ${
          new Date(date).toDateString() === new Date().toDateString()
            ? "bg-cta-color/15"
            : "bg-tertiary-bg"
        }`}>
        {/* Date Label */}
        <span className="font-semibold text-secondary-text absolute top-1 left-2 z-10">
          {date.getDate()}
          {view === "Weekly"
            ? ` ${date.toLocaleString("default", { month: "short" })}`
            : ""}
        </span>
        {jobsForDay.length + meetingsForDay.length > 0 && (
          <span className="absolute top-2 right-2 text-xs text-error-color">
            {jobsForDay.length + meetingsForDay.length} item
            {jobsForDay.length + meetingsForDay.length !== 1 ? "s" : ""}
          </span>
        )}

        {/* Indicators */}
        <div className="absolute top-8 bottom-1 left-1 right-1 overflow-y-auto flex flex-col justify-start gap-1">
          {jobsForDay.length > 0 && view === "Weekly"
            ? jobsForDay.map((job) => (
                <span
                  key={job.id}
                  className="bg-blue-400/30 text-primary-text p-1 flex flex-row gap-2 rounded">
                  <div className="bg-blue-500 rounded-full w-0.75 h-full"></div>
                  <div className="flex flex-col gap-1">
                    <p className="font-semibold text-sm">Changeover</p>
                    <p className="text-xs">{job.propertyDetails.name}</p>
                  </div>
                </span>
              ))
            : jobsForDay.length > 0 &&
              view === "Monthly" && (
                <span className="bg-blue-400/30 text-primary-text text-xs px-1 rounded">
                  {jobsForDay.length} Changeover
                  {jobsForDay.length > 1 ? "s" : ""}
                </span>
              )}
          {meetingsForDay.length > 0 && view === "Monthly" ? (
            <span className="bg-green-400/30 text-primary-text text-xs px-1 rounded">
              {meetingsForDay.length} Meeting
              {meetingsForDay.length > 1 ? "s" : ""}
            </span>
          ) : (
            jobsForDay.length > 0 &&
            view === "Weekly" &&
            meetingsForDay.map((meeting) => (
              <span
                key={meeting.id}
                className="bg-green-400/30 p-1 rounded flex flex-row gap-2">
                <div className="bg-green-500 rounded-full w-0.75 h-full"></div>
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-semibold text-primary-text">
                    Meeting
                  </p>
                  <p className="text-xs text-primary-text">{meeting.title}</p>
                  <p className="text-xs text-secondary-text">
                    {`${new Date(meeting.start_date).toLocaleString("default", {
                      hour: "numeric",
                      minute: "numeric",
                    })} - ${new Date(meeting.end_date).toLocaleString(
                      "default",
                      {
                        hour: "numeric",
                        minute: "numeric",
                      }
                    )}`}
                  </p>
                </div>
              </span>
            ))
          )}
        </div>
      </div>
    );
  };

  // --- WEEKDAY TITLES ---
  const weekDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className="h-full bg-primary-bg flex items-center justify-center">
      <div className="shadow-m h-full w-full flex flex-col overflow-hidden">
        {/* Header */}
        <header className="p-3 gap-3 border-border-color flex justify-between items-center bg-tertiary-bg text-primary-text">
          <h1 className="text-2xl flex-1 font-bold">
            {view === "Monthly"
              ? currentDate.toLocaleString("default", {
                  month: "long",
                  year: "numeric",
                })
              : (() => {
                  const tempDate = new Date(currentDate);
                  tempDate.setHours(0, 0, 0, 0);
                  const dayNum = (tempDate.getDay() + 6) % 7;
                  tempDate.setDate(tempDate.getDate() - dayNum + 3);
                  const firstThursday = new Date(tempDate.getFullYear(), 0, 4);
                  const weekNumber = Math.floor(
                    1 + (tempDate - firstThursday) / (7 * 24 * 60 * 60 * 1000)
                  );
                  return `Week ${weekNumber}, ${tempDate.getFullYear()}`;
                })()}
          </h1>
          <div className="flex w-60 items-center gap-4">
            <SlidingSelectorGeneric
              options={["Weekly", "Monthly"]}
              value={view}
              onChange={setView}
            />
          </div>
          <div className="flex gap-2 items-center shadow-s bg-secondary-bg p-1 rounded-xl">
            <CTAButton
              width="w-28"
              type="main"
              text="Previous"
              callbackFn={view === "Monthly" ? prevMonth : prevWeek}
            />
            <CTAButton
              width="w-28"
              type="main"
              text="Next"
              callbackFn={view === "Monthly" ? nextMonth : nextWeek}
            />
          </div>
        </header>

        {/* Weekday Headers */}
        <div className="grid grid-cols-7 bg-secondary-bg border-t border-border-color">
          {weekDays.map((day) => (
            <div
              key={day}
              className="text-center font-semibold text-secondary-text uppercase py-2 border-r border-border-color last:border-r-0">
              {day}
            </div>
          ))}
        </div>

        {/* Calendar Grid */}
        <main
          className={`flex-1 border-border-color border-t bg-secondary-bg grid ${
            view === "Monthly" ? "grid-cols-7" : "grid-cols-7 grid-rows-1"
          } overflow-hidden`}>
          {view === "Monthly"
            ? calendarDays.map((date, idx) => renderDayCell(date, idx))
            : weeklyDays.map((date, idx) => renderDayCell(date, idx))}
        </main>
      </div>
    </div>
  );
}
