import { useState } from "react";
import { ArrowUpRight, ArrowDownRight, Users, Wallet } from "lucide-react";
import { useNavigate } from "react-router-dom";

const users = [
  { name: "Gladyce", img: "https://i.pravatar.cc/100?img=1" },
  { name: "Elbert", img: "https://i.pravatar.cc/100?img=2" },
  { name: "Joyce", img: "https://i.pravatar.cc/100?img=3" },
  { name: "Sarah", img: "https://i.pravatar.cc/100?img=4" },
  { name: "Leo", img: "https://i.pravatar.cc/100?img=5" },
];

export default function ClientManagementOverviewCard() {
  const navigate = useNavigate();
  const [active, setActive] = useState("Owners");

  return (
    <div className="bg-secondary-bg text-white p-5 rounded-3xl shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl text-primary-text font-semibold">Overview</h2>
        <button className="bg-neutral-800 px-4 py-2 rounded-full text-sm text-white hover:bg-neutral-700 transition">
          Last 7 days ▾
        </button>
      </div>

      {/* Stats Section */}
      <div className="relative flex flex-col md:flex-row bg-primary-bg p-2 rounded-3xl gap-6 overflow-hidden">
        {/* Animated background indicator */}
        <div
          className={`absolute top-2 bottom-2 left-2 w-[calc(50%-0.75rem)] rounded-2xl bg-gradient-to-r from-indigo-600/50 to-purple-600/50 transition-all duration-500 ease-out ${
            active === "Properties"
              ? "translate-x-[calc(100%+0.75rem)]"
              : "translate-x-0"
          }`}
          style={{ zIndex: 0 }}></div>

        {/* Owners */}
        <div
          onClick={() => setActive("Owners")}
          className={`flex-1 relative cursor-pointer p-6 rounded-2xl flex flex-col justify-center gap-3 transition-all duration-300 ${
            active === "Owners" ? "text-white" : "text-primary-text"
          }`}
          style={{ zIndex: 1 }}>
          <div className="flex items-center gap-2 mb-2">
            <Users size={22} />
            <span className="">Owners</span>
          </div>
          <div className="flex items-end justify-between">
            <span className="text-5xl font-bold">84</span>
            <span className="flex items-center gap-1 text-red-400 bg-red-500/10 px-2 py-1 rounded-lg text-sm">
              <ArrowDownRight size={14} />
              36.8%
            </span>
          </div>
        </div>

        {/* Properties */}
        <div
          onClick={() => setActive("Properties")}
          className={`flex-1 relative cursor-pointer p-6 rounded-2xl flex flex-col justify-center gap-3 transition-all duration-300 ${
            active === "Properties" ? "text-white" : "text-primary-text "
          }`}
          style={{ zIndex: 1 }}>
          <div className="flex items-center gap-2 mb-2">
            <Wallet size={22} />
            <span className="">Properties</span>
          </div>
          <div className="flex items-end justify-between">
            <span className="text-5xl font-bold">52</span>
            <span className="flex items-center gap-1 text-green-400 bg-green-500/10 px-2 py-1 rounded-lg text-sm">
              <ArrowUpRight size={14} />
              36.8%
            </span>
          </div>
        </div>
      </div>

      {/* New customers */}
      <div className="mt-8">
        <p className="text-lg text-primary-text font-medium">
          857 new customers today!
        </p>
        <p className="text-sm text-secondary-text mb-6">
          Send a welcome message to all new customers.
        </p>

        <div className="flex items-center justify-between">
          <div className="flex gap-6">
            {users.map((user, i) => (
              <div key={i} className="flex flex-col items-center">
                <img
                  src={user.img}
                  alt={user.name}
                  className="w-14 h-14 rounded-full border border-gray-700"
                />
                <span className="text-sm text-secondary-text mt-2">
                  {user.name}
                </span>
              </div>
            ))}
          </div>

          <button
            onClick={() =>
              active === "Owners"
                ? navigate("/Client-Management/Owners")
                : navigate("/Client-Management/Properties")
            }
            className="bg-neutral-800 flex gap-3 p-4 rounded-full hover:bg-neutral-700 transition">
            <ArrowUpRight /> View All {active}
          </button>
        </div>
      </div>
    </div>
  );
}
