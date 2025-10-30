import MeetingCard from "./MeetingCard";
import { IoCalendarOutline } from "react-icons/io5";

const LeadMeeting = ({ meeting }) => {
  return (
    <div className="flex items-stretch flex-col mr-5">
      <div className="flex p-3 flex-col">
        <div className="flex flex-row gap-3 justify-start items-center">
          <div className="flex rounded-full justify-center items-center w-9 h-9 bg-cta-color">
            <IoCalendarOutline className="w-5 h-5 text-white" />
          </div>
          <div className="flex justify-center items-center rounded-full p-0.5 bg-primary-text">
            {meeting.created_by?.avatar ? (
              <img
                src={meeting.created_by.avatar || ""}
                alt="Avatar"
                className="rounded-full object-cover w-8 h-8"
              />
            ) : (
              <div className="rounded-full w-8 h-8 bg-green-800">
                <p className="text-white text-sm flex items-center justify-center h-full">
                  {meeting.created_by?.first_name?.charAt(0)}
                  {meeting.created_by?.surname?.charAt(0)}
                </p>
              </div>
            )}
          </div>
          <p className="text-sm text-secondary-text">
            <span className="text-primary-text">
              {meeting.created_by.first_name || ""}{" "}
              {meeting.created_by.surname || ""}
            </span>{" "}
            scheduled a meeting
          </p>
          <div className="rounded-full w-1 h-1 bg-muted/50"></div>
          <p className="text-sm text-muted/50">
            {new Date(meeting.created_at).toLocaleTimeString([], {
              day: "2-digit",
              month: "short",
              year: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              meridian: true,
            }) || ""}
          </p>
        </div>
      </div>
      <div className="flex flex-row justify-start items-stretch">
        <div className="w-[2px] rounded-full bg-border-color ml-6.5"></div>
        <MeetingCard meeting={meeting} />
      </div>
    </div>
  );
};

export default LeadMeeting;
