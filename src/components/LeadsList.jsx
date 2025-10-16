import { Mail, Phone, Building2 } from "lucide-react";
import CTAButton from "./CTAButton";
import { LuArrowUpRight } from "react-icons/lu";
import { AiOutlineUserAdd } from "react-icons/ai";
import { IoAddOutline } from "react-icons/io5";

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
  const statusColor = {
    "Hot Lead": "bg-red-400/20 text-red-500",
    "Follow-up": "bg-yellow-400/20 text-yellow-500",
    "Cold Lead": "bg-blue-400/20 text-blue-500",
  };

  return (
    <div className="bg-secondary-bg shadow-m rounded-3xl h-full flex flex-col">
      <div className="flex p-6 justify-between items-center ">
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

      <div className="flex px-4 flex-col gap-4 overflow-y-scroll [&::-webkit-scrollbar]:hidden">
        {leads.map((lead) => (
          <div
            key={lead.id}
            className="bg-tertiary-bg rounded-2xl border border-border-color transition-shadow duration-200">
            <div className="p-3 px-4 bg-primary-bg rounded-t-2xl w-full flex flex-row justify-between items-center">
              <h3 className="text-lg font-semibold flex items-center gap-2 text-primary-text">
                <Building2 className="w-5 h-5 text-secondary-text" />
                {lead.company}
              </h3>
              <span
                className={`text-xs font-medium px-3 py-2 rounded-full ${
                  statusColor[lead.status]
                }`}>
                {lead.status}
              </span>
            </div>

            <div className="p-4 h-40 text-sm space-y-2">
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
                  onClick={() => alert(`Viewing details for ${lead.company}`)}
                />
                <CTAButton
                  icon={AiOutlineUserAdd}
                  width="w-full"
                  type="success"
                  text="Convert to Client"
                  onClick={() => alert(`Converting ${lead.company} to client`)}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
