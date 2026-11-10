import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, ListIcon, PlayIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useAudits, useAuditMutation, useAuditSchedule } from "../../hooks/useAudits";
import { useMachines } from "../../hooks/useProcessControl";
import { usePermissions } from "../../hooks/useQmsApi";
import { useAuditScheduleFilters } from "../../hooks/useUrlFilters";
import { auditorLabel, monthBounds, monthLabel, monthWeeks, shiftMonth, SLOT_STATES, slotLabel, slotPill } from "../../lib/audits";
import { formatDate } from "../../lib/ncr";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import ReasonDialog from "../ncr/ReasonDialog";
import Dialog from "../ui/Dialog";
import { ErrorNotice, SelectField } from "../master-data/shared";
import StartAuditDialog from "./StartAuditDialog";
import SlidingToggle from "../ui/SlidingToggle";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A figure at the top of the page; the state ones are buttons that filter the list to that state. */
const Tile = ({ label, value, note, state, active, onPick }) => {
  const body = (
    <>
      <span className="text-xs uppercase tracking-wide text-tertiary-text">{label}</span>
      <span className="text-2xl font-semibold text-primary-text">{value}</span>
      {note && <span className="text-xs text-secondary-text">{note}</span>}
    </>
  );
  const cls = "flex min-w-36 flex-1 flex-col rounded-2xl border bg-secondary-bg px-4 py-3 text-left";
  return state ? (
    <button type="button" aria-pressed={active} onClick={() => onPick(active ? "" : state)} className={`${cls} cursor-pointer hover:border-border-dark-color ${active ? "border-brand-primary" : "border-border-color"}`}>
      {body}
    </button>
  ) : (
    <div className={`${cls} border-border-color`}>{body}</div>
  );
};

/** What can be done with one slot: start or continue the audit, open its record, skip it or put it back. */
const SlotActions = ({ item, canPerform, canManage, onSkip, onChanged }) => {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const mutation = useAuditMutation();
  const start = () =>
    mutation.mutate(
      { path: "/audit-records", body: { auditId: item.audit.id, occurrenceId: item.id } },
      {
        onSuccess: (record) => {
          showToast({ type: "success", title: "Audit started", message: `${record.reference} is open.` });
          navigate(`/Documentation/Audit-Records/${record.id}`);
        },
        onError: (e) => showToast({ type: "error", title: "Could not start the audit", message: e.message }),
      }
    );
  const open = item.state === "upcoming" || item.state === "overdue" || item.state === "missed";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {open && canPerform && (
        <CTAButton buttonType="button" type="secondary" size="md" disabled={mutation.isPending} loading={mutation.isPending} onClick={start} aria-label={`Start ${item.audit.reference} due ${item.dueOn}`}>
          <PlayIcon className="mr-1 inline" aria-hidden="true" /> Start audit
        </CTAButton>
      )}
      {open && canManage && (
        <CTAButton buttonType="button" type="neutral" size="md" onClick={() => onSkip(item)} aria-label={`Skip ${item.audit.reference} due ${item.dueOn}`}>
          Skip
        </CTAButton>
      )}
      {item.record && (
        <Link to={`/Documentation/Audit-Records/${item.record.id}`} className="text-sm font-medium text-link-color hover:underline" onClick={onChanged}>
          {item.state === "in_progress" ? `Continue ${item.record.reference}` : `View ${item.record.reference}`}
        </Link>
      )}
      {item.state === "skipped" && canManage && (
        <CTAButton
          buttonType="button"
          type="neutral" size="md"
          disabled={mutation.isPending} loading={mutation.isPending}
          onClick={() => mutation.mutate({ path: `/audit-occurrences/${item.id}/unskip` }, { onSuccess: onChanged })}
          aria-label={`Put back ${item.audit.reference} due ${item.dueOn}`}>
          Put back
        </CTAButton>
      )}
    </div>
  );
};

const SlotPill = ({ item }) => <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${slotPill(item)}`}>{slotLabel(item)}</span>;

const dueText = (item) => {
  const d = item.daysFromToday;
  if (item.state === "done" || item.state === "skipped" || item.state === "in_progress") return formatDate(item.dueOn);
  if (d === 0) return `${formatDate(item.dueOn)} (today)`;
  if (d > 0) return `${formatDate(item.dueOn)} (in ${d} ${d === 1 ? "day" : "days"})`;
  return `${formatDate(item.dueOn)} (${-d} ${d === -1 ? "day" : "days"} ago)`;
};

const SlotDialog = ({ item, onClose, ...actions }) => (
  <Dialog title={`${item.audit.reference} · ${item.audit.title}`} onClose={onClose}>
    <div className="flex flex-col gap-3 text-sm text-primary-text">
      <div className="flex flex-wrap items-center gap-2">
        <SlotPill item={item} />
        <span>Due {dueText(item)}</span>
      </div>
      <p className="text-secondary-text">
        {item.audit.relevantTo.length ? `Relevant to ${item.audit.relevantTo.join(", ")}. ` : ""}Expected auditor: {auditorLabel(item.audit.auditor)}. Pass mark {item.audit.passMark}%.
      </p>
      {item.state === "skipped" && <p>Skipped: {item.skippedReason}</p>}
      {item.record?.result && (
        <p>
          {item.record.reference} was carried out on {formatDate(item.record.performedOn)}: {item.record.result === "pass" ? "passed" : "failed"} ({item.record.score}%).
        </p>
      )}
      <Link to={`/Documentation/Audits/${item.audit.id}`} className="w-fit text-link-color hover:underline">
        Open the audit
      </Link>
      <SlotActions item={item} {...actions} onChanged={onClose} />
    </div>
  </Dialog>
);

const List = ({ items, ...actions }) =>
  items.length === 0 ? (
    <p className="rounded-2xl border border-border-color bg-secondary-bg p-6 text-sm text-secondary-text">No scheduled audits match.</p>
  ) : (
    <div className="overflow-x-auto rounded-2xl border border-border-color bg-secondary-bg">
      <table aria-label="Scheduled audits" className="w-full min-w-3xl text-left text-sm text-primary-text">
        <thead>
          <tr className="border-b border-border-color text-xs uppercase tracking-wide text-tertiary-text">
            <th scope="col" className="px-4 py-2 font-medium">Due</th>
            <th scope="col" className="px-4 py-2 font-medium">Audit</th>
            <th scope="col" className="px-4 py-2 font-medium">Relevant to</th>
            <th scope="col" className="px-4 py-2 font-medium">Expected auditor</th>
            <th scope="col" className="px-4 py-2 font-medium">State</th>
            <th scope="col" className="px-4 py-2 font-medium"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-border-color last:border-0 align-top">
              <td className="whitespace-nowrap px-4 py-3">{dueText(item)}</td>
              <td className="px-4 py-3">
                <Link to={`/Documentation/Audits/${item.audit.id}`} className="font-medium text-link-color hover:underline">
                  {item.audit.reference}
                </Link>{" "}
                {item.audit.title}
              </td>
              <td className="px-4 py-3 text-secondary-text">{item.audit.relevantTo.join(", ") || "—"}</td>
              <td className="px-4 py-3 text-secondary-text">{item.audit.auditor.kind === "none" ? "—" : item.audit.auditor.name}</td>
              <td className="px-4 py-3">
                <SlotPill item={item} />
                {item.state === "skipped" && item.skippedReason && <p className="mt-1 max-w-56 text-xs text-secondary-text">{item.skippedReason}</p>}
              </td>
              <td className="px-4 py-3">
                <SlotActions item={item} {...actions} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

const Calendar = ({ month, today, items, onPick }) => {
  const byDay = new Map();
  items.forEach((i) => byDay.set(i.dueOn, [...(byDay.get(i.dueOn) ?? []), i]));
  return (
    <div role="grid" aria-label={`Audit calendar, ${monthLabel(month)}`} className="overflow-x-auto">
      <div className="grid min-w-3xl grid-cols-7 gap-px rounded-2xl border border-border-color bg-border-color">
        {DAY_NAMES.map((d) => (
          <div key={d} role="columnheader" className="bg-secondary-bg px-2 py-1 text-xs font-medium uppercase tracking-wide text-tertiary-text">
            {d}
          </div>
        ))}
        {monthWeeks(month).flat().map((day) => {
          const inMonth = day.startsWith(month);
          const list = byDay.get(day) ?? [];
          return (
            <div key={day} role="gridcell" aria-label={day} className={`flex min-h-24 flex-col gap-1 p-1.5 ${inMonth ? "bg-secondary-bg" : "bg-primary-bg"} ${day === today ? "ring-2 ring-inset ring-brand-primary" : ""}`}>
              <span className={`text-xs tabular-nums ${inMonth ? "text-primary-text" : "text-tertiary-text"} ${day === today ? "font-semibold" : ""}`}>{Number(day.slice(8))}</span>
              {list.map((item) => (
                <button key={item.id} type="button" onClick={() => onPick(item)} className={`truncate rounded-md px-1.5 py-0.5 text-left text-xs font-medium cursor-pointer ${slotPill(item)}`} title={`${item.audit.reference} · ${item.audit.title}: ${slotLabel(item)}`}>
                  {item.audit.reference} {slotLabel(item)}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/** The audit schedule (Documentation → Audit schedule): what is coming up, overdue, missed and done, as a list or a month calendar. */
const AuditSchedulePage = () => {
  const { can } = usePermissions();
  const canPerform = can("audits.perform");
  const canManage = can("audits.manage");
  const filters = useAuditScheduleFilters();
  const { updateFilters } = filters;
  const audits = useAudits({ status: "active", sort: "title", pageSize: 200 });
  const machines = useMachines({ includeInactive: true });
  const skipMutation = useAuditMutation();
  const [skipping, setSkipping] = useState(null);
  const [slot, setSlot] = useState(null);
  const [starting, setStarting] = useState(false);

  const view = filters.view === "calendar" ? "calendar" : "list";
  const thisMonth = new Date().toISOString().slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(filters.month) ? filters.month : view === "calendar" ? thisMonth : "";
  const bounds = month ? monthBounds(month) : {};
  const { data, isLoading, error } = useAuditSchedule({
    from: bounds.from,
    to: bounds.to,
    state: view === "list" ? filters.state : undefined,
    auditId: filters.audit,
    machineId: filters.machine,
  });
  const c = data?.counts;
  const items = data?.data ?? [];
  const pick = (state) => updateFilters({ state });
  const move = (by) => updateFilters({ month: shiftMonth(month || thisMonth, by) });

  const actions = { canPerform, canManage, onSkip: setSkipping };
  const machineItems = machines.data?.items ?? [];
  const auditItems = audits.data?.data ?? [];

  return (
    <div className="flex w-full min-w-0 flex-1 min-h-0 flex-col gap-3 overflow-auto bg-primary-bg p-4">
      <div className="flex flex-row flex-wrap items-center justify-between gap-3 pl-1">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <p className="text-sm text-primary-text" aria-live="polite">
            {data ? (month ? monthLabel(month) : `${formatDate(data.window.from)} to ${formatDate(data.window.to)}`) : ""}
          </p>
        </div>
        <div className="flex flex-row flex-wrap items-center justify-end gap-3">
          <SlidingToggle
            ariaLabel="View"
            options={[{ value: "list", label: "List", icon: ListIcon }, { value: "calendar", label: "Calendar", icon: CalendarIcon }]}
            value={view}
            onChange={(v) => updateFilters({ view: v === "list" ? "" : v })}
          />
          {canPerform && <CTAButton callbackFn={() => setStarting(true)} text="Start an unscheduled audit" type="main" icon={PlayIcon} iconSize="h-6 w-6" title="Carry out an audit now, without a scheduled slot" />}
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Tile label="Due in 7 days" value={c?.dueNext7Days ?? "—"} state="upcoming" active={filters.state === "upcoming"} onPick={pick} note="Upcoming audits" />
        <Tile label="Overdue" value={c?.overdue ?? "—"} state="overdue" active={filters.state === "overdue"} onPick={pick} note="Inside the grace period" />
        <Tile label="Missed" value={c?.missed ?? "—"} state="missed" active={filters.state === "missed"} onPick={pick} note="Past the grace period" />
        <Tile label="In progress" value={c?.inProgress ?? "—"} state="in_progress" active={filters.state === "in_progress"} onPick={pick} />
        <Tile label="Done" value={c?.done ?? "—"} state="done" active={filters.state === "done"} onPick={pick} note={c ? `${c.donePassed} passed, ${c.doneFailed} failed` : undefined} />
        <Tile label="Pass rate" value={c?.passRate == null ? "—" : `${c.passRate}%`} note="Of audits done" />
        <Tile label="On time" value={c?.onTimeRate == null ? "—" : `${c.onTimeRate}%`} note="Done by the deadline, of done or missed" />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:max-w-3xl lg:grid-cols-3">
        <SelectField label="Audit" value={filters.audit} onChange={(v) => updateFilters({ audit: v ?? "", auditLabel: "" })} options={auditItems.map((a) => ({ value: a.id, label: `${a.reference} · ${a.title}` }))} placeholder="Any audit" />
        <SelectField label="Machine" value={filters.machine} onChange={(v) => updateFilters({ machine: v ?? "", machineLabel: "" })} options={machineItems.map((m) => ({ value: m.id, label: `${m.code} · ${m.name}` }))} placeholder="Any machine" />
        {view === "list" && <SelectField label="State" value={filters.state} onChange={(v) => updateFilters({ state: v ?? "" })} options={SLOT_STATES} placeholder="Any state" />}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <CTAButton buttonType="button" aria-label="Previous month" type="neutral" size="md" onClick={() => move(-1)}>
          <ChevronLeftIcon aria-hidden="true" />
        </CTAButton>
        <CTAButton buttonType="button" aria-label="Next month" type="neutral" size="md" onClick={() => move(1)}>
          <ChevronRightIcon aria-hidden="true" />
        </CTAButton>
        <CTAButton buttonType="button" type="neutral" size="md" onClick={() => updateFilters({ month: "" })} disabled={!filters.month}>
          {view === "calendar" ? "This month" : "Around today"}
        </CTAButton>
      </div>

      {error && <ErrorNotice error={error} />}
      {isLoading ? (
        <p className="text-secondary-text">Loading…</p>
      ) : view === "calendar" ? (
        <Calendar month={month} today={data?.today} items={items} onPick={setSlot} />
      ) : (
        <List items={items} {...actions} />
      )}
      {data?.truncated && <p className="text-sm text-secondary-text">Only the first 500 scheduled audits are shown. Narrow the dates or the filters.</p>}

      {slot && <SlotDialog item={items.find((i) => i.id === slot.id) ?? slot} onClose={() => setSlot(null)} {...actions} onSkip={(i) => { setSlot(null); setSkipping(i); }} />}
      {skipping && (
        <ReasonDialog
          title={`Skip ${skipping.audit.reference} due ${formatDate(skipping.dueOn)}?`}
          label="Why is it being skipped?"
          confirmText="Skip audit"
          pending={skipMutation.isPending}
          error={skipMutation.error}
          onClose={() => setSkipping(null)}
          onConfirm={(reason) => skipMutation.mutate({ path: `/audit-occurrences/${skipping.id}/skip`, body: { reason } }, { onSuccess: () => setSkipping(null) })}
        />
      )}
      {starting && <StartAuditDialog onClose={() => setStarting(false)} />}
    </div>
  );
};

export default AuditSchedulePage;
