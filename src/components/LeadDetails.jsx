import { useEffect } from "react";
import LeadCorrespondence from "./LeadCorrespondence.jsx";
import LeadMeeting from "./LeadMeeting.jsx";
import { HiOutlinePhone } from "react-icons/hi2";
import { TfiEmail } from "react-icons/tfi";

const LeadDetails = () => {
  const statusColor = {
    "Hot Lead": "bg-red-400/20 text-red-500",
    "Follow-up": "bg-yellow-400/20 text-yellow-500",
    "Cold Lead": "bg-blue-400/20 text-blue-500",
  };

  useEffect(() => {
    const container = document.querySelector(".flex-6");
    const header = document.getElementById("lead-header");

    const handleScroll = () => {
      if (container.scrollTop > 10) {
        header.setAttribute("data-scrolled", "true");
      } else {
        header.removeAttribute("data-scrolled");
      }
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div className="flex items-stretch p-4 h-full gap-4 bg-primary-bg">
      <div className="bg-secondary-bg relative overflow-y-auto [&::-webkit-scrollbar]:hidden inset-m flex-6 border border-border-color rounded-3xl">
        {/* Sticky Header */}
        <div
          className="sticky rounded-t-3xl inset-m top-0 z-10 backdrop-blur-md bg-secondary-bg/60 border-b border-transparent 
          data-[scrolled=true]:border-border-color data-[scrolled=true]:bg-secondary-bg/40 
          "
          id="lead-header">
          <div className="flex justify-between items-start flex-col p-4">
            <div className="flex justify-between w-full flex-row items-center">
              <h2 className="text-xl text-primary-text font-semibold mb-1">
                ACME Corporation - Lead Activity
              </h2>
              <span
                className={`text-xs font-medium px-3 py-2 rounded-xl ${statusColor["Hot Lead"]}`}>
                {"Hot Lead"}
              </span>
            </div>
            <div className="flex justify-start mt-1 items-center gap-3 w-full">
              <p className="text-sm text-primary-text">Sarah Johnson</p>
              <div className="w-1 h-1 bg-secondary-text rounded-full"></div>
              <div className="flex items-center">
                <HiOutlinePhone className="inline-block text-secondary-text mr-1" />
                <p className="text-sm text-secondary-text">07548598632</p>
              </div>
              <div className="w-1 h-1 bg-secondary-text rounded-full"></div>
              <div className="flex items-center">
                <TfiEmail className="inline-block text-secondary-text mr-1" />
                <p className="text-sm text-secondary-text">
                  sarah.johnson@example.com
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="space-y-4 p-4 pt-2">
          <LeadCorrespondence />
          <LeadCorrespondence />
          <LeadMeeting />
          <LeadCorrespondence />
          <LeadCorrespondence />
          <LeadCorrespondence />
        </div>
      </div>

      <div className="bg-secondary-bg p-4 flex-4 rounded-3xl border border-border-color"></div>
    </div>
  );
};

export default LeadDetails;
