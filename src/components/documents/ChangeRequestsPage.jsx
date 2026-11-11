import { useState } from "react";
import { usePermissions } from "../../hooks/useQmsApi";
import { useChangeRequests } from "../../hooks/useDocuments";
import { ErrorNotice } from "../master-data/shared";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { ChangeRequestRow } from "./LifecyclePanels";

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "accepted", label: "Accepted" },
  { value: "declined", label: "Declined" },
  { value: "all", label: "All" },
];

/** Change requests (`/Documentation/Change-Requests`): document managers see and decide every request; others see the ones they asked for. */
const ChangeRequestsPage = () => {
  const { can } = usePermissions();
  const manage = can("documentation.manage");
  const [status, setStatus] = useState("open");
  const [mine, setMine] = useState(manage ? "" : "true");
  const requests = useChangeRequests({ status, mine: mine || undefined });

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <header>
        <h1 className="text-2xl font-semibold text-primary-text">Change requests</h1>
        <p className="text-sm text-secondary-text">Requests for a change to a document. Ask for one from the document itself.</p>
      </header>
      <div className="flex flex-wrap gap-3">
        <SlidingToggle ariaLabel="Status" options={STATUS_OPTIONS} value={status} onChange={setStatus} />
        {manage && <SlidingToggle ariaLabel="Whose" options={[{ value: "", label: "Everyone's" }, { value: "true", label: "Mine" }]} value={mine} onChange={setMine} />}
      </div>
      {requests.isLoading ? (
        <LoadingScreen />
      ) : requests.error ? (
        <ErrorNotice error={requests.error} />
      ) : (
        <MenuCard title={`${requests.data.length} ${requests.data.length === 1 ? "request" : "requests"}`}>
          {requests.data.length === 0 ? (
            <p className="text-sm text-secondary-text">None.</p>
          ) : (
            <ul aria-label="Change requests" className="-my-3 divide-y divide-border-color">
              {requests.data.map((c) => (
                <ChangeRequestRow key={c.id} request={c} canManage={manage} showDocument />
              ))}
            </ul>
          )}
        </MenuCard>
      )}
    </div>
  );
};

export default ChangeRequestsPage;
