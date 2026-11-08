import { Link } from "react-router-dom";
import MenuCard from "../ui/MenuCard";
import StatTile from "../ui/StatTile";
import LoadingScreen from "../ui/LoadingScreen";
import ClassificationList from "./ClassificationList";
import { FactoryIcon, PackageIcon, UsersIcon } from "@/components/icons";
import { usePermissions } from "../../hooks/useQmsApi";
import { useClassifications } from "../../hooks/useNcr";
import { NC_SOURCES, STAGES } from "../../lib/ncr";
import { StagePill } from "../ncr/Pills";
import { describeApiError } from "../../lib/api-client";

const STAGE_HELP = {
  draft: "Being written; not yet raised.",
  open: "Raised: category, severity, quantity and (for customer/supplier sources) the customer or supplier are recorded.",
  contained: "Affected product is secured.",
  investigating: "Root cause is being investigated.",
  dispositioned: "A decision has been made on the affected product.",
  awaiting_closure: "Corrective action is being verified.",
  closed: "Complete. Locked until reopened (with a reason).",
  cancelled: "Raised in error or a duplicate (with a reason). Locked until reopened.",
};

const MASTER_DATA = [
  { to: "/Customers", label: "Customers", hint: "Who you make product for", Icon: UsersIcon },
  { to: "/Suppliers", label: "Suppliers", hint: "Where material comes from", Icon: FactoryIcon },
  { to: "/Parts", label: "Parts", hint: "Products, revisions and specs", Icon: PackageIcon },
];

const Stat = ({ label, active, total }) => <StatTile label={label} value={active} note={total - active > 0 ? `${total - active} inactive` : "all active"} />;

const SettingsDataManagement = () => {
  const { can } = usePermissions();
  const canManage = can("lookups.manage");
  const { data: lists, error, isLoading } = useClassifications({ includeInactive: true });
  const count = (rows) => ({ active: rows.filter((r) => r.active).length, total: rows.length });
  const fm = lists && count(lists.failureModes);
  const sub = lists && count(lists.subFailureModes);
  const cat = lists && count(lists.categories);

  return (
    <div className="flex w-full grow flex-col gap-4 pr-2">
      <div>
        <h2 className="text-2xl font-semibold text-primary-text">Data Management</h2>
        <p className="text-sm text-secondary-text">
          Lists used when recording non-conformances.{canManage ? " Switch an entry off to retire it without losing history." : " You can view them; an administrator can change them."}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-error-color">
          {describeApiError(error)}
        </p>
      )}
      {isLoading && <LoadingScreen size="sm" />}
      {lists && (
        <>
          <div className="flex flex-wrap gap-3">
            <Stat label="Categories" {...cat} />
            <Stat label="Failure modes" {...fm} />
            <Stat label="Sub-failure modes" {...sub} />
          </div>
          <MenuCard title="Categories" subtitle="What kind of problem a non-conformance is (the source says where it came from). Add your own; switch one off to retire it.">
            <ClassificationList kind="category" lists={lists} canManage={canManage} />
          </MenuCard>
          <MenuCard title="Failure modes" subtitle="Failure modes and their sub-failure modes">
            <ClassificationList kind="failure_mode" lists={lists} canManage={canManage} />
          </MenuCard>
          <MenuCard title="Where detected and causal process" subtitle="These two fields on a non-conformance pick a machine. Add or change machines under Master Data.">
            <Link to="/Machines" className="text-sm text-link-color hover:underline">
              Open the machines
            </Link>
          </MenuCard>
        </>
      )}
      <MenuCard title="Sources" subtitle="Where a non-conformance came from or was detected. The list is fixed; each non-conformance has one source and one category.">
        <ul className="grid gap-2 sm:grid-cols-2">
          {NC_SOURCES.map((s) => (
            <li key={s.key} className="rounded-xl border border-border-color px-3 py-2">
              <p className="font-medium text-primary-text">{s.label}</p>
              <p className="text-xs text-secondary-text">
                {s.hint}
                {s.party === "customer" && ". Needs the customer to open."}
                {s.party === "supplier" && ". Needs the supplier to open."}
                {s.party === "supplier?" && ". May name the supplier."}
              </p>
            </li>
          ))}
        </ul>
      </MenuCard>
      <MenuCard title="NCR stages" subtitle="How a non-conformance moves from draft to closed">
        <ol className="flex flex-col">
          {STAGES.map((s, i) => (
            <li key={s.key} className="flex items-stretch gap-4">
              <div className="flex flex-col items-center">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border-color bg-primary-bg text-xs text-secondary-text">{i + 1}</span>
                {i < STAGES.length - 1 && <span className="w-px grow bg-border-color" />}
              </div>
              <div className="flex flex-wrap items-start gap-x-3 gap-y-1 pb-4 text-sm text-primary-text">
                <span className="w-36 shrink-0">
                  <StagePill stage={s.key} />
                </span>
                <span className="min-w-0 flex-1 text-secondary-text">{STAGE_HELP[s.key]}</span>
              </div>
            </li>
          ))}
        </ol>
      </MenuCard>
      <MenuCard title="Customers, suppliers and products" subtitle="Managed under Master Data">
        <div className="grid gap-3 sm:grid-cols-3">
          {MASTER_DATA.map(({ to, label, hint, Icon }) => (
            <Link key={to} to={to} className="flex items-center gap-3 rounded-xl border border-border-color p-3 transition-colors hover:border-brand-primary hover:bg-border-color/30">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-border-color/60 text-lg text-primary-text">
                <Icon />
              </span>
              <span className="flex flex-col">
                <span className="font-medium text-primary-text">{label}</span>
                <span className="text-xs text-secondary-text">{hint}</span>
              </span>
            </Link>
          ))}
        </div>
      </MenuCard>
    </div>
  );
};

export default SettingsDataManagement;
