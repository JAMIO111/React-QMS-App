import { useState, useRef, useEffect } from "react";
import { ArrowUpRight, ArrowDownRight, Users, Wallet } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function ClientManagementOverviewCard({
  owners = [],
  properties = [],
}) {
  const navigate = useNavigate();
  const [active, setActive] = useState("Owners");
  const containerRef = useRef(null);
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    const updateVisibleCount = () => {
      if (!containerRef.current) return;

      const containerWidth = containerRef.current.getBoundingClientRect().width;
      const avatarWidth = 56; // w-14 = 56px
      const gap = 36; // gap-6 = 24px
      const totalPerAvatar = avatarWidth + gap;

      // Add a small buffer so rounding doesn’t undercount
      const count = Math.floor((containerWidth + gap / 2) / totalPerAvatar) - 1;
      setVisibleCount(Math.max(count, 1));
    };

    updateVisibleCount();
    window.addEventListener("resize", updateVisibleCount);
    return () => window.removeEventListener("resize", updateVisibleCount);
  }, []);

  return (
    <div className="bg-secondary-bg shadow-m text-white p-5 rounded-3xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl text-primary-text font-semibold">Overview</h2>
        <button className="bg-neutral-800 px-4 py-2 rounded-full text-sm text-white hover:bg-neutral-700 transition">
          Last 7 days ▾
        </button>
      </div>

      {/* Stats Section */}
      <div className="relative flex flex-col md:flex-row bg-primary-bg p-2 shadow-s rounded-3xl gap-6 overflow-hidden">
        {/* Animated background indicator */}
        <div
          className={`absolute top-2 bottom-2 left-2 w-[calc(50%-0.75rem)] rounded-2xl bg-tertiary-bg transition-all duration-500 ease-out ${
            active === "Properties"
              ? "translate-x-[calc(100%+0.5rem)]"
              : "translate-x-0"
          }`}
          style={{ zIndex: 0 }}></div>

        {/* Owners */}
        <div
          onClick={() => setActive("Owners")}
          className={`flex-1 relative cursor-pointer p-4 rounded-2xl flex flex-col justify-center gap-3 transition-all duration-300 "text-black"
          `}
          style={{ zIndex: 1 }}>
          <div className="flex items-center gap-2 mb-2">
            <Users size={22} />
            <span>Owners</span>
          </div>
          <div className="flex items-end justify-between">
            <span className="text-5xl font-bold">
              {owners.filter((o) => o.is_active).length}
            </span>
            <span className="flex items-center gap-1 text-red-400 bg-red-500/10 px-2 py-1 rounded-lg text-sm">
              <ArrowDownRight size={14} />
              36.8%
            </span>
          </div>
        </div>

        {/* Properties */}
        <div
          onClick={() => setActive("Properties")}
          className={`flex-1 relative cursor-pointer p-4 rounded-2xl flex flex-col justify-center gap-3 transition-all duration-300 text-white`}
          style={{ zIndex: 1 }}>
          <div className="flex items-center gap-2 mb-2">
            <Wallet size={22} />
            <span>Properties</span>
          </div>
          <div className="flex items-end justify-between">
            <span className="text-5xl font-bold">
              {properties.filter((p) => p.is_active).length}
            </span>
            <span className="flex items-center gap-1 text-green-400 bg-green-500/10 px-2 py-1 rounded-lg text-sm">
              <ArrowUpRight size={14} />
              36.8%
            </span>
          </div>
        </div>
      </div>

      {/* New Customers */}
      <div className="mt-4">
        <p className="text-lg text-primary-text font-medium">
          857 new customers today!
        </p>
        <p className="text-sm text-secondary-text mb-6">
          Send a welcome message to all new customers.
        </p>

        <div className="flex gap-5 items-center justify-between">
          <div
            ref={containerRef}
            className="flex gap-6 overflow-hidden flex-nowrap flex-grow">
            {owners.slice(0, visibleCount).map((owner, i) => (
              <button
                onClick={() =>
                  navigate(`/Client-Management/Owners/${owner.id}`)
                }
                key={i}
                className="flex flex-col items-center flex-shrink-0">
                <img
                  src={
                    owner.img || `https://i.pravatar.cc/100?u=${owner.id || i}`
                  }
                  alt={owner.first_name || owner.surname}
                  className="w-14 h-14 rounded-full border border-gray-700"
                />
                <span className="text-sm text-secondary-text mt-2 truncate max-w-[4rem]">
                  {owner.first_name || owner.surname}
                </span>
              </button>
            ))}

            {owners.length > visibleCount && (
              <div className="flex flex-col items-center justify-start">
                <div className="w-14 h-14 flex items-center pr-1 text-lg justify-center rounded-full bg-neutral-700">
                  +{owners.length - visibleCount}
                </div>
              </div>
            )}
          </div>

          <button
            onClick={() =>
              active === "Owners"
                ? navigate("/Client-Management/Owners")
                : navigate("/Client-Management/Properties")
            }
            className="bg-neutral-800 shadow-s flex gap-3 p-4 rounded-full hover:bg-neutral-700 transition">
            <ArrowUpRight /> View All {active}
          </button>
        </div>
      </div>
    </div>
  );
}
