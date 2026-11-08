import { useCallback, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeftIcon, PencilIcon, PlusIcon, Trash2Icon } from "@/components/icons";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import { usePermissions } from "../../hooks/useQmsApi";
import { usePartFamily, useProcessControlMutation } from "../../hooks/useProcessControl";
import { useParts } from "../../hooks/useMasterData";
import { useConfirm } from "../../contexts/ConfirmationModalProvider";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { PartFamilyForm } from "./PartFamiliesPage";
import ActiveAlertsBanner from "../documentation/ActiveAlertsBanner";

import { ActiveBadge, ErrorNotice, FormError, SearchBox } from "./shared";
import LoadingScreen from "../ui/LoadingScreen";
import { currentRevisionLabel } from "../../lib/partRevisions";
import CTAButton from "@/components/CTAButton";

/** Choose parts to add to the family; parts in another family are moved (shown with their family). */
const AddPartsForm = ({ family, onDone }) => {
  const mutation = useProcessControlMutation();
  const [q, setQ] = useState("");
  const onSearch = useCallback((v) => setQ(v), []);
  const parts = useParts({ q });
  const [chosen, setChosen] = useState([]);
  const candidates = (parts.data?.items ?? []).filter((p) => p.partFamily?.id !== family.id);
  const moving = candidates.filter((p) => chosen.includes(p.id) && p.partFamily);

  const submit = (e) => {
    e.preventDefault();
    mutation.mutate({ path: `/part-families/${family.id}/parts`, body: { add: chosen } }, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <SearchBox label="Search part number, name or customer part number" onSearch={onSearch} />
      <div className="max-h-72 overflow-y-auto rounded-lg border border-border-color p-2" role="group" aria-label="Parts">
        {parts.isLoading && <LoadingScreen size="sm" />}
        {!parts.isLoading && candidates.length === 0 && <p className="text-sm text-secondary-text">No other parts match.</p>}
        {candidates.map((p) => (
          <label key={p.id} className="flex items-center gap-2 py-1 text-sm text-primary-text">
            <input
              type="checkbox"
              checked={chosen.includes(p.id)}
              onChange={(e) => setChosen((c) => (e.target.checked ? [...c, p.id] : c.filter((x) => x !== p.id)))}
            />
            <span className="font-mono">{p.partNumber}</span>
            <span className="text-secondary-text">· {p.name}</span>
            {p.partFamily && <span className="ml-auto text-xs text-secondary-text">now in {p.partFamily.code}</span>}
          </label>
        ))}
        {parts.hasNextPage && (
          <CTAButton buttonType="button" type="neutral" size="md" className="mt-2" onClick={() => parts.fetchNextPage()}>
            Load more
          </CTAButton>
        )}
      </div>
      {moving.length > 0 && (
        <p className="text-sm text-primary-text">
          {moving.length === 1 ? `${moving[0].partNumber} moves` : `${moving.length} parts move`} from another family into {family.code}; that family's control plans
          will no longer apply to {moving.length === 1 ? "it" : "them"}.
        </p>
      )}
      <FormError error={mutation.error} />
      <div className="flex justify-end gap-2">
        <CTAButton buttonType="button" type="neutral" size="md" onClick={onDone}>
          Cancel
        </CTAButton>
        <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending || chosen.length === 0}>
          {mutation.isPending ? "Adding…" : chosen.length ? `Add ${chosen.length} part${chosen.length === 1 ? "" : "s"}` : "Add parts"}
        </CTAButton>
      </div>
    </form>
  );
};

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
  const [adding, setAdding] = useState(false);
  const membership = useProcessControlMutation();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const removePart = async (p) => {
    const ok = await confirm({
      title: `Take ${p.partNumber} out of ${family.code}?`,
      message: "Family control plans will no longer apply to it.",
      confirmText: "Remove",
      cancelText: "Cancel",
      type: "warning",
    });
    if (ok)
      membership.mutate(
        { path: `/part-families/${family.id}/parts`, body: { remove: [p.id] } },
        { onError: (err) => showToast({ type: "error", title: "Not removed", message: describeApiError(err) }) }
      );
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <Link to="/Part-Families" className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
        <ArrowLeftIcon className="h-4 w-4" /> Part families
      </Link>
      {isLoading && <LoadingScreen />}
      {error && <ErrorNotice error={error} />}
      {family && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-primary-text">
              {family.code} <span className="font-normal text-secondary-text">· {family.name}</span>
            </h1>
            <ActiveBadge active={family.active} />
            {canManage && (
              <CTAButton buttonType="button" type="neutral" size="md" className="flex items-center gap-1" onClick={() => setEditing(true)}>
                <PencilIcon className="h-4 w-4" /> Edit
              </CTAButton>
            )}
          </div>
          {family.description && <p className="max-w-3xl text-sm text-primary-text">{family.description}</p>}
          <ActiveAlertsBanner partFamilyId={family.id} />

          <MenuCard
            title="Parts"
            subtitle="Parts in this family get the family's control plans (unless a plan of their own overrides it)."
            bodyClassName="overflow-x-auto"
            action={
              canManage && (
                <CTAButton buttonType="button" type="neutral" size="md" className="flex items-center gap-1" onClick={() => setAdding(true)}>
                  <PlusIcon className="h-4 w-4" /> Add parts
                </CTAButton>
              )
            }>
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
                    {canManage && <th scope="col" className={th}><span className="sr-only">Actions</span></th>}
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
                      <td className={`${td} font-mono`}>{currentRevisionLabel(p) ?? "—"}</td>
                      <td className={td}>
                        <ActiveBadge active={p.active} />
                      </td>
                      {canManage && (
                        <td className={td}>
                          <div className="flex justify-end">
                            <CTAButton buttonType="button" type="danger" size="md" disabled={membership.isPending} onClick={() => removePart(p)} aria-label={`Remove ${p.partNumber} from the family`}>
                              <Trash2Icon className="h-4 w-4" />
                            </CTAButton>
                          </div>
                        </td>
                      )}
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
          {adding && (
            <Dialog title={`Add parts to ${family.code}`} onClose={() => setAdding(false)} width="max-w-2xl">
              <AddPartsForm family={family} onDone={() => setAdding(false)} />
            </Dialog>
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
