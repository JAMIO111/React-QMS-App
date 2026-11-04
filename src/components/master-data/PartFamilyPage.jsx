import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeftIcon, PencilIcon } from "@/components/icons";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import { usePermissions } from "../../hooks/useQmsApi";
import { usePartFamily } from "../../hooks/useProcessControl";
import { PartFamilyForm } from "./PartFamiliesPage";
import { ActiveBadge, buttonClass, ErrorNotice } from "./shared";

const th = "border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text";
const td = "border-b border-border-color px-2 py-2";

/** One part family: its parts and the control plans that cover it. */
const PartFamilyPage = () => {
  const { id } = useParams();
  const { can } = usePermissions();
  const canManage = can("master_data.manage");
  const canSeePlans = can("process_control.read");
  const { data: family, isLoading, error } = usePartFamily(id);
  const [editing, setEditing] = useState(false);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <Link to="/Part-Families" className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
        <ArrowLeftIcon className="h-4 w-4" /> Part families
      </Link>
      {isLoading && <p className="text-secondary-text">Loading family…</p>}
      {error && <ErrorNotice error={error} />}
      {family && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-primary-text">
              {family.code} <span className="font-normal text-secondary-text">· {family.name}</span>
            </h1>
            <ActiveBadge active={family.active} />
            {canManage && (
              <button type="button" className={`${buttonClass.neutral} flex items-center gap-1`} onClick={() => setEditing(true)}>
                <PencilIcon className="h-4 w-4" /> Edit
              </button>
            )}
          </div>
          {family.description && <p className="max-w-3xl text-sm text-primary-text">{family.description}</p>}

          <MenuCard title="Parts" subtitle="Assign a part to this family on the part's own page." bodyClassName="overflow-x-auto">
            {family.parts.length === 0 ? (
              <p className="text-sm text-secondary-text">No parts in this family yet.</p>
            ) : (
              <table className="w-full min-w-[480px] border-separate border-spacing-0 text-sm text-primary-text">
                <thead>
                  <tr>
                    <th scope="col" className={th}>Part number</th>
                    <th scope="col" className={th}>Name</th>
                    <th scope="col" className={th}>Current revision</th>
                    <th scope="col" className={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {family.parts.map((p) => (
                    <tr key={p.id}>
                      <td className={td}>
                        <Link to={`/Parts/${p.id}`} className="font-medium text-link-color hover:underline">
                          {p.partNumber}
                        </Link>
                      </td>
                      <td className={td}>{p.name}</td>
                      <td className={`${td} font-mono`}>{p.currentRevision ?? "—"}</td>
                      <td className={td}>
                        <ActiveBadge active={p.active} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </MenuCard>

          {canSeePlans && (
            <MenuCard title="Control plans" subtitle="Plans whose scope includes this family." bodyClassName="overflow-x-auto">
              {family.plans.length === 0 ? (
                <p className="text-sm text-secondary-text">No control plan covers this family yet.</p>
              ) : (
                <table className="w-full min-w-[480px] border-separate border-spacing-0 text-sm text-primary-text">
                  <thead>
                    <tr>
                      <th scope="col" className={th}>Plan</th>
                      <th scope="col" className={th}>Title</th>
                      <th scope="col" className={th}>Scope</th>
                      <th scope="col" className={th}>Effective revision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {family.plans.map((p) => (
                      <tr key={p.id}>
                        <td className={td}>
                          <Link to={`/Process-Control/Plans/${p.id}`} className="font-medium text-link-color hover:underline">
                            {p.planCode}
                          </Link>
                        </td>
                        <td className={td}>{p.title}</td>
                        <td className={td}>{p.scope}</td>
                        <td className={`${td} font-mono`}>{p.effectiveRevision ?? <span className="font-sans text-secondary-text">None</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </MenuCard>
          )}
          {editing && (
            <Dialog title={`Edit ${family.code}`} onClose={() => setEditing(false)}>
              <PartFamilyForm family={family} onDone={() => setEditing(false)} />
            </Dialog>
          )}
        </>
      )}
    </div>
  );
};

export default PartFamilyPage;
