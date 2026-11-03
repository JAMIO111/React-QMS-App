import { IoLocationOutline } from "react-icons/io5";

const MeetingCard = ({ meeting }) => {
  const start = meeting?.start_date ? new Date(meeting.start_date) : null;
  const end = meeting?.end_date ? new Date(meeting.end_date) : null;
  console.log("Meeting Data:", meeting);
  return (
    <div className="bg-tertiary-bg mb-5 flex flex-row gap-4 shadow-s rounded-lg p-3 ml-10">
      <div className="flex flex-col p-2 h-12 w-12 items-center rounded-md justify-center bg-primary-bg">
        <p className="text-xs font-[500] text-error-color">
          {start
            ? start.toLocaleString("default", { month: "short" }).toUpperCase()
            : ""}
        </p>
        <p className="text-primary-text font-semibold">
          {start?.getDate() || ""}
        </p>
      </div>
      <div className="flex flex-col justify-center gap-1 mr-12">
        <p className="text-sm text-primary-text font-semibold">
          {meeting?.title || "Meeting Title"}
        </p>
        <p className="text-xs text-secondary-text">
          {start?.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }) || ""}{" "}
          -{" "}
          {end?.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }) || ""}
        </p>
      </div>
      <div className="flex gap-2 flex-col">
        <div className="rounded-md shadow-s flex flex-row items-center justify-between py-1 px-2 bg-tertiary-bg">
          <IoLocationOutline className="w-4 h-4 text-secondary-text" />
          <p className="text-xs text-secondary-text">
            {meeting?.location || "Starbucks"}
          </p>
        </div>
      </div>
    </div>
  );
};

export default MeetingCard;
