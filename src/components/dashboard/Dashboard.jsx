import { Link } from "react-router-dom";
import { useUser } from "@/contexts/UserProvider";
import { getGreeting } from "@/lib/HelperFunctions";

const registers = [
  { name: "Internal non-conformances", path: "/Non-Conformance/Internal" },
  { name: "Customer non-conformances", path: "/Non-Conformance/Customer" },
  { name: "Supplier non-conformances", path: "/Non-Conformance/Supplier" },
];

const Dashboard = () => {
  const { profile } = useUser();

  return (
    <div className="flex flex-col flex-1 gap-5 p-5 overflow-auto bg-primary-bg">
      <h1 className="text-xl font-semibold text-primary-text pl-1">
        {getGreeting()}
        {profile?.first_name ? `, ${profile.first_name}` : ""}
      </h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {registers.map((r) => (
          <Link
            key={r.path}
            to={r.path}
            className="p-4 rounded-xl border border-border-color bg-secondary-bg text-primary-text hover:border-brand-primary transition-colors">
            {r.name}
          </Link>
        ))}
      </div>
    </div>
  );
};

export default Dashboard;
