import { Mail, Phone, Building2 } from "lucide-react";
import CTAButton from "./CTAButton";
import { LuArrowUpRight } from "react-icons/lu";
import { AiOutlineUserAdd } from "react-icons/ai";
import { IoAddOutline } from "react-icons/io5";
import { useNavigate } from "react-router-dom";
import { useEffect } from "react";

const leads = [
  {
    id: 1,
    company: "Acme Manufacturing Ltd.",
    contact: "Sarah Davies",
    email: "sarah@acmemfg.co.uk",
    phone: "+44 7856 112233",
    status: "Hot Lead",
  },
  {
    id: 2,
    company: "Northshore Logistics",
    contact: "James O'Connor",
    email: "james@northshorelogistics.com",
    phone: "+44 7701 665544",
    status: "Follow-up",
  },
  {
    id: 3,
    company: "Zenith Engineering Co.",
    contact: "Lucy Smith",
    email: "lucy@zenitheng.co.uk",
    phone: "+44 7445 333222",
    status: "Cold Lead",
  },
];

export default function LeadList() {
  const navigate = useNavigate();
  const statusColor = {
    "Hot Lead": "bg-red-400/20 text-red-500",
    "Follow-up": "bg-yellow-400/20 text-yellow-500",
    "Cold Lead": "bg-blue-400/20 text-blue-500",
  };

  useEffect(() => {
    const container = document.getElementById("lead-list-scroll");
    const header = document.getElementById("lead-list-header");

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
    <div className="bg-secondary-bg border border-border-color rounded-3xl h-full flex flex-col overflow-hidden">
      {/* Make this the scroll container */}
      <div
        id="lead-list-scroll"
        className="relative flex flex-col overflow-y-auto flex-grow [&::-webkit-scrollbar]:hidden">
        {/* Header INSIDE the scroll container */}
        <div
          id="lead-list-header"
          className="sticky top-0 inset-m z-10 rounded-t-3xl backdrop-blur-md bg-secondary-bg/70 
                 border-b border-transparent 
                 data-[scrolled=true]:border-border-color/60 
                 data-[scrolled=true]:bg-secondary-bg/50
                 p-6 py-3 flex justify-between items-center">
          <div className="flex flex-col justify-between items-start">
            <h2 className="text-xl text-primary-text font-semibold">
              Business Leads
            </h2>
            <p className="text-sm text-secondary-text">
              {leads.length} Open leads to manage
            </p>
          </div>
          <CTAButton
            icon={IoAddOutline}
            width="w-auto"
            type="main"
            text="Add New Lead"
            onClick={() => alert("Add New Lead Clicked")}
          />
        </div>

        {/* Scrollable cards */}
        <div className="flex p-4 pt-1 flex-col gap-4">
          {leads.map((lead) => (
            <div
              key={lead.id}
              className="bg-primary-bg p-1.5 rounded-2xl shadow-s transition-shadow duration-200">
              <div className="pt-2 pb-3 px-2 bg-primary-bg rounded-t-2xl w-full flex flex-row justify-between items-center">
                <h3 className="text-lg font-semibold flex items-center gap-2 text-primary-text">
                  <Building2 className="w-5 h-5 text-secondary-text" />
                  {lead.company}
                </h3>
                <span
                  className={`text-xs font-medium px-3 py-2 rounded-xl ${
                    statusColor[lead.status]
                  }`}>
                  {lead.status}
                </span>
              </div>

              <div className="p-4 bg-tertiary-bg border border-border-color/50 rounded-xl h-40 text-sm space-y-2">
                <p className="font-medium text-primary-text">{lead.contact}</p>
                <div className="flex items-center gap-2 text-secondary-text">
                  <Mail className="w-4 h-4" />
                  <span>{lead.email}</span>
                </div>
                <div className="flex items-center gap-2 text-secondary-text">
                  <Phone className="w-4 h-4" />
                  <span>{lead.phone}</span>
                </div>

                <div className="flex gap-6 mt-4 flex-row justify-between items-center">
                  <CTAButton
                    icon={LuArrowUpRight}
                    width="w-full"
                    type="main"
                    text="View Details"
                    callbackFn={() =>
                      navigate(`/Client-Management/Leads/${lead.id}`)
                    }
                  />
                  <CTAButton
                    icon={AiOutlineUserAdd}
                    width="w-full"
                    type="success"
                    text="Convert to Client"
                    onClick={() =>
                      alert(`Converting ${lead.company} to client`)
                    }
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
