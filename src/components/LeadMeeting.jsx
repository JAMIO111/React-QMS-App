import MeetingCard from "./MeetingCard";

const LeadMeeting = () => {
  return (
    <div className="flex items-stretch flex-col mr-5">
      <div className="flex p-3 flex-col">
        <div className="flex flex-row gap-3 justify-start items-center">
          <div className="rounded-full w-7 h-7 bg-blue-400"></div>
          <div className="rounded-full w-7 h-7 bg-green-400"></div>
          <p className="text-sm text-secondary-text">
            <span className="text-primary-text">Jade Dryden</span> scheduled a
            meeting
          </p>
          <div className="rounded-full w-1 h-1 bg-muted/50"></div>
          <p className="text-sm text-muted/50">3:52 PM</p>
        </div>
      </div>
      <div className="flex flex-row justify-start items-stretch">
        <div className="w-[2px] rounded-full bg-border-color ml-6.5"></div>
        <MeetingCard
          meeting={{
            date: new Date(),
            clientName: "David Johnson",
            startTime: "10:00 AM",
            endTime: "11:00 AM",
            location: "Starbucks",
          }}
        />
      </div>
    </div>
  );
};

export default LeadMeeting;
