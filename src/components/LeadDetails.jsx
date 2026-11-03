import { useEffect } from "react";
import LeadCorrespondence from "./LeadCorrespondence.jsx";
import LeadMeeting from "./LeadMeeting.jsx";
import { HiOutlinePhone } from "react-icons/hi2";
import { TfiEmail } from "react-icons/tfi";
import { useLeadById } from "@/hooks/useLeadById.jsx";
import { useNavigate, useParams } from "react-router-dom";

const LeadDetails = () => {
  const navigate = useNavigate();
  const { id } = useParams();
  const { data: lead, isLoading, isError, error } = useLeadById(id);
  console.log("Lead Data:", lead);
  const statusColor = {
    "Hot Lead": "bg-red-400/20 text-red-500",
    "Follow-up": "bg-yellow-400/20 text-yellow-500",
    "Cold Lead": "bg-blue-400/20 text-blue-500",
  };

  const engagementItems = [
    ...(lead?.Meetings?.map((m) => ({ ...m, type: "meeting" })) ?? []),
    ...(lead?.Correspondence?.map((c) => ({ ...c, type: "correspondence" })) ??
      []),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));

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
                {lead?.title || "Unknown Company"} - Lead Activity
              </h2>
              <span
                className={`text-sm font-medium px-3 py-2 rounded-xl ${
                  statusColor[lead?.status] || "bg-gray-200 text-gray-600"
                }`}>
                {lead?.status || "No Status"}
              </span>
            </div>
            <div className="flex justify-start mt-1 items-center gap-3 w-full">
              <p className="text-sm text-primary-text">
                {lead?.first_name || ""} {lead?.surname || ""}
              </p>
              {lead?.phone && (
                <>
                  <div className="w-1 h-1 bg-secondary-text rounded-full"></div>
                  <div className="flex items-center">
                    <HiOutlinePhone className="inline-block text-secondary-text mr-1" />
                    <p className="text-sm text-secondary-text">
                      {lead?.phone || "Unknown Phone"}
                    </p>
                  </div>
                </>
              )}
              {lead?.email && (
                <>
                  <div className="w-1 h-1 bg-secondary-text rounded-full"></div>
                  <div className="flex items-center">
                    <TfiEmail className="inline-block text-secondary-text mr-1" />
                    <p className="text-sm text-secondary-text">
                      {lead?.email || "Unknown Email"}
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="space-y-4 p-4 pt-2">
          {isLoading ? (
            <div className="flex justify-center bg-tertiary-bg shadow-s rounded-2xl items-center h-40">
              <p className="text-secondary-text animate-pulse">
                Loading engagement items...
              </p>
            </div>
          ) : engagementItems.length > 0 ? (
            engagementItems.map((item) => {
              if (item.type === "meeting") {
                return <LeadMeeting key={item.id} meeting={item} />;
              }
              return <LeadCorrespondence key={item.id} correspondence={item} />;
            })
          ) : (
            <div className="flex bg-tertiary-bg rounded-2xl shadow-s flex-col justify-center items-center h-40 text-primary-text">
              <p>No engagement items found.</p>
              <p className="text-xs text-muted-text mt-2">
                Try adding a meeting or logging correspondence using the form on
                the right.
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="bg-secondary-bg p-4 flex-4 rounded-3xl border border-border-color"></div>
    </div>
  );
};

export default LeadDetails;
