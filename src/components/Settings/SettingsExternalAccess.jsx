import { useMemo, useState } from "react";
import MenuCard from "../ui/MenuCard";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import Switch from "../ui/Switch";
import ComboField from "../ui/ComboField";
import RowActionsMenu from "../ui/RowActionsMenu";
import LoadingScreen from "../ui/LoadingScreen";
import CTAButton from "@/components/CTAButton";
import { TextAreaField } from "../master-data/shared";
import { PlusIcon } from "@/components/icons";
import { usePermissions } from "../../hooks/useQmsApi";
import { useExternalAccess, useExternalAccessMutation, useExternalPeople } from "../../hooks/usePortal";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { CUSTOMER_TILES, PERFORMANCE_TILES, ROLE_LABEL, accessStatus, lastSeenWords, partyKindLabel, personLine, tileOn } from "../../lib/portal";

const Pill = ({ tone, children }) => {
  const cls = {
    success: "bg-success-color/15 text-success-color",
    warning: "bg-warning-color/15 text-warning-color",
    error: "bg-error-color/15 text-error-color",
    neutral: "bg-secondary-bg text-secondary-text",
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
};

/**
 * Settings → External access (docs/external-portal-plan.md PT1): the supplier and customer portal. The owner switches it on, then opts in each
 * supplier or customer and invites their first contact, who invites their own colleagues. Needs external_access.read to see it and
 * external_access.manage to change it; the server checks both again.
 */
const SettingsExternalAccess = () => {
  const { can, isLoading } = usePermissions();
  if (isLoading) return <LoadingScreen />;
  if (!can("external_access.read")) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Callout tone="info" title="External access">
          Only the organisation&apos;s owners, administrators and quality managers can see these settings.
        </Callout>
      </div>
    );
  }
  return <Page canManage={can("external_access.manage")} />;
};

export default SettingsExternalAccess;

function Page({ canManage }) {
  const overview = useExternalAccess();
  const mutate = useExternalAccessMutation();
  const { showToast } = useToast();
  const [people, setPeople] = useState(null); // the party whose people dialog is open
  const [tilesFor, setTilesFor] = useState(null); // the supplier whose performance tiles are being chosen
  const [search, setSearch] = useState("");

  const parties = useMemo(() => {
    const all = overview.data?.parties ?? [];
    const q = search.trim().toLowerCase();
    return q ? all.filter((p) => `${p.name} ${p.code}`.toLowerCase().includes(q)) : all;
  }, [overview.data, search]);

  if (overview.isLoading) return <LoadingScreen />;
  if (overview.error) return <div className="p-4"><Callout tone="error">{describeApiError(overview.error)}</Callout></div>;
  const { settings } = overview.data;
  const fail = (title) => (error) => showToast({ type: "error", title, message: describeApiError(error) });

  return (
    <div className="flex flex-col gap-4">
      <MenuCard
        title="Supplier and customer portal"
        titleId="portal-switch-title"
        subtitle="Let your suppliers and customers sign in to see and respond to the quality matters you share with them."
        bodyClassName="flex flex-col gap-3"
        action={
          <Switch
            checked={settings.enabled}
            disabled={!canManage}
            aria-labelledby="portal-switch-title"
            onChange={(e) => mutate.mutate({ action: "settings", body: { enabled: e.target.checked } }, { onError: fail("Not changed") })}
          />
        }>
        <p className="text-sm text-secondary-text">
          {settings.enabled
            ? "The portal is on. Only the suppliers and customers you switch on below can use it, and only the people you or their own administrator invite."
            : "The portal is off. Nobody outside your organisation can sign in to it until you switch it on."}
        </p>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border-color px-4 py-3">
          <div>
            <p id="portal-mfa-title" className="text-sm font-medium text-primary-text">Require two-factor authentication for external people</p>
            <p className="text-xs text-secondary-text">They sign in with a code from an authenticator app. Recommended, because these accounts sit outside your company.</p>
          </div>
          <Switch
            checked={settings.requireMfa}
            disabled={!canManage}
            aria-labelledby="portal-mfa-title"
            onChange={(e) => mutate.mutate({ action: "settings", body: { requireMfa: e.target.checked } }, { onError: fail("Not changed") })}
          />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border-color px-4 py-3">
          <div>
            <p id="portal-ranking-title" className="text-sm font-medium text-primary-text">Show suppliers where they stand among your suppliers</p>
            <p className="text-xs text-secondary-text">A band only (top quarter, upper half and so on), never names or numbers, and only once at least five suppliers have a score. You can still switch it off for one supplier.</p>
          </div>
          <Switch
            checked={settings.rankingEnabled}
            disabled={!canManage}
            aria-labelledby="portal-ranking-title"
            onChange={(e) => mutate.mutate({ action: "settings", body: { rankingEnabled: e.target.checked } }, { onError: fail("Not changed") })}
          />
        </div>
      </MenuCard>

      <MenuCard
        title="Who can use it"
        subtitle="Switch on the suppliers and customers who should have access, then invite their first contact."
        bodyClassName="flex flex-col gap-3">
        {!settings.enabled && <Callout tone="info">Switch the portal on above before inviting anyone.</Callout>}
        <Field label="Search suppliers and customers" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or code" />
        {parties.length === 0 ? (
          <p className="text-sm text-secondary-text">No suppliers or customers match.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-color rounded-xl border border-border-color" aria-label="Suppliers and customers">
            {parties.map((p) => (
              <li key={`${p.kind}-${p.recordId}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 grow">
                  <p className="truncate text-sm font-medium text-primary-text">{p.name}</p>
                  <p className="text-xs text-secondary-text">
                    {partyKindLabel(p.kind)} · {p.code}
                    {p.enabled ? ` · ${p.activePeople} active, ${p.invitedPeople} invited` : ""}
                  </p>
                </div>
                {p.enabled ? <Pill tone="success">On</Pill> : <Pill tone="neutral">Off</Pill>}
                {canManage && (
                  <Switch
                    checked={p.enabled}
                    aria-label={`Portal access for ${p.name}`}
                    onChange={(e) => mutate.mutate({ action: "party", body: { kind: p.kind, partyId: p.recordId, enabled: e.target.checked } }, { onError: fail("Not changed") })}
                  />
                )}
                {p.enabled && canManage && (
                  <CTAButton type="neutral" size="default" aria-label={p.kind === "supplier" ? `Performance tiles for ${p.name}` : `Options for ${p.name}`} onClick={() => setTilesFor(p)}>
                    {p.kind === "supplier" ? "Tiles" : "Options"}
                  </CTAButton>
                )}
                {p.enabled && (
                  <CTAButton type="neutral" size="default" aria-label={`People at ${p.name}`} onClick={() => setPeople(p)}>
                    People
                  </CTAButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </MenuCard>

      <AccessReport />
      {tilesFor && (
        <TilesDialog
          party={(overview.data.parties.find((x) => x.kind === tilesFor.kind && x.recordId === tilesFor.recordId)) ?? tilesFor}
          rankingOn={settings.rankingEnabled}
          onClose={() => setTilesFor(null)}
          onChange={(tiles) => mutate.mutate({ action: "party", body: { kind: tilesFor.kind, partyId: tilesFor.recordId, tiles } }, { onError: fail("Not changed") })}
        />
      )}
      {people && <PeopleDialog party={people} canManage={canManage} onClose={() => setPeople(null)} portalOn={settings.enabled} />}
    </div>
  );
}

/** Everyone with access across every supplier and customer, with their last sign-in, so leavers and stale accounts are easy to spot. */
/** Which figures a supplier sees on its Performance page. Each switch saves at once; a tile left on follows the default. */
function TilesDialog({ party, rankingOn, onChange, onClose }) {
  const current = party.tiles ?? {};
  return (
    <Dialog title={party.kind === "supplier" ? `Performance tiles for ${party.name}` : `Options for ${party.name}`} onClose={onClose} width="max-w-lg">
      <p className="text-sm text-secondary-text">
        {party.kind === "supplier"
          ? `Choose what ${party.name} sees on its Performance page. The figures are the ones on your own Performance tab for this supplier.`
          : `Choose what ${party.name} can do in the portal.`}
      </p>
      <ul aria-label="Performance tiles" className="mt-3 flex flex-col divide-y divide-border-color rounded-xl border border-border-color">
        {(party.kind === "supplier" ? PERFORMANCE_TILES : CUSTOMER_TILES).map((tile) => (
          <li key={tile.key} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="text-sm text-primary-text">
              {tile.label}
              {tile.key === "ranking" && !rankingOn && <span className="block text-xs text-secondary-text">Switch on the position among suppliers for the portal first.</span>}
            </span>
            <Switch
              checked={tileOn(current, tile.key)}
              aria-label={tile.label}
              onChange={(e) => onChange({ ...current, [tile.key]: e.target.checked })}
            />
          </li>
        ))}
      </ul>
      <div className="mt-4 flex justify-end">
        <CTAButton type="main" size="md" onClick={onClose}>Done</CTAButton>
      </div>
    </Dialog>
  );
}

function AccessReport() {
  const people = useExternalPeople();
  const rows = (people.data?.data ?? []).filter((p) => p.status !== "removed");
  return (
    <MenuCard title="Access report" subtitle="Everyone who can sign in, or has been invited, and when they last did." bodyClassName="flex flex-col gap-2">
      {people.isLoading ? (
        <p className="text-sm text-secondary-text">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-secondary-text">Nobody has been invited yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-color rounded-xl border border-border-color" aria-label="External people">
          {rows.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <span className="min-w-0 grow truncate text-primary-text">{personLine(p)}</span>
              <span className="text-secondary-text">{p.partyName}</span>
              <Pill tone={accessStatus(p.status).tone}>{accessStatus(p.status).label}</Pill>
              <span className="w-36 text-right text-xs text-secondary-text">Last sign-in: {lastSeenWords(p.lastSignInAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </MenuCard>
  );
}

function PeopleDialog({ party, canManage, portalOn, onClose }) {
  const people = useExternalPeople({ partyId: party.partyId });
  const mutate = useExternalAccessMutation();
  const { showToast } = useToast();
  const [contact, setContact] = useState(party.contactName ?? "");
  const [form, setForm] = useState({ email: "", role: "admin", message: "" });
  const [reasonFor, setReasonFor] = useState(null); // { kind: 'remove' | 'suspend', person }
  const [reason, setReason] = useState("");
  const rows = people.data?.data ?? [];
  const hasAdmin = rows.some((p) => p.role === "admin" && p.status !== "removed");
  const fail = (title) => (error) => showToast({ type: "error", title, message: describeApiError(error) });

  const invite = (e) => {
    e.preventDefault();
    mutate.mutate(
      { action: "invite", body: { partyId: party.partyId, email: form.email, role: form.role, message: form.message || undefined } },
      {
        onSuccess: (res) => {
          setForm({ email: "", role: "member", message: "" });
          showToast({
            type: res.email?.sent ? "success" : "warning",
            title: res.email?.sent ? "Invitation sent" : "Invitation saved",
            message: res.email?.sent ? `An email has gone to ${res.person.email}.` : "No email could be sent from here. The person will see the invitation when they sign in with that address.",
          });
        },
        onError: fail("Not invited"),
      },
    );
  };

  const doReason = (e) => {
    e.preventDefault();
    mutate.mutate({ action: reasonFor.kind, id: reasonFor.person.id, body: { reason } }, { onSuccess: () => setReasonFor(null), onError: fail("Not changed") });
  };

  if (reasonFor) {
    return (
      <Dialog title={reasonFor.kind === "remove" ? `Remove ${reasonFor.person.email}` : `Suspend ${reasonFor.person.email}`} onClose={() => setReasonFor(null)}>
        <form onSubmit={doReason} className="flex flex-col gap-3" noValidate>
          <p className="text-sm text-secondary-text">
            {reasonFor.kind === "remove"
              ? "Their access ends at once. What they wrote stays on the records under their name."
              : "Their access stops at once. You can bring it back later."}
          </p>
          <TextAreaField label="Reason" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex justify-end gap-2">
            <CTAButton type="neutral" size="md" onClick={() => setReasonFor(null)}>Cancel</CTAButton>
            <CTAButton type="danger" size="md" buttonType="submit" disabled={reason.trim().length < 3} loading={mutate.isPending}>
              {reasonFor.kind === "remove" ? "Remove" : "Suspend"}
            </CTAButton>
          </div>
        </form>
      </Dialog>
    );
  }

  return (
    <Dialog title={`People at ${party.name}`} onClose={onClose} width="max-w-2xl">
      <div className="flex flex-col gap-4">
        {canManage && (
          <div className="flex items-end gap-2">
            <Field className="grow" label="Your contact, as they see it" hint="Shown to them as who to talk to. Leave empty to show your organisation’s name." value={contact} maxLength={120} onChange={(e) => setContact(e.target.value)} />
            <CTAButton
              type="neutral"
              size="md"
              disabled={contact.trim() === (party.contactName ?? "")}
              onClick={() => mutate.mutate({ action: "party", body: { kind: party.kind, partyId: party.recordId, contactName: contact.trim() || null } }, { onError: fail("Not saved") })}>
              Save
            </CTAButton>
          </div>
        )}

        <ul className="flex flex-col divide-y divide-border-color rounded-xl border border-border-color" aria-label={`People at ${party.name}`}>
          {rows.filter((p) => p.status !== "removed").map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <div className="min-w-0 grow">
                <p className="truncate text-primary-text">{personLine(p)}</p>
                <p className="text-xs text-secondary-text">
                  {ROLE_LABEL[p.role]} · last sign-in: {lastSeenWords(p.lastSignInAt)}
                  {p.status === "invited" && p.inviteExpiresAt ? ` · invitation expires ${new Date(p.inviteExpiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}
                </p>
              </div>
              <Pill tone={accessStatus(p.status).tone}>{accessStatus(p.status).label}</Pill>
              {canManage && (
                <RowActionsMenu
                  label={`Actions for ${p.email}`}
                  items={[
                    p.status === "invited" && { label: "Send invitation again", onSelect: () => mutate.mutate({ action: "resend", id: p.id }, { onSuccess: () => showToast({ type: "success", title: "Sent", message: "The invitation has been sent again." }), onError: fail("Not sent") }) },
                    p.status === "active" && { label: "Suspend", onSelect: () => { setReason(""); setReasonFor({ kind: "suspend", person: p }); } },
                    p.status === "suspended" && { label: "Bring back", onSelect: () => mutate.mutate({ action: "restore", id: p.id }, { onError: fail("Not changed") }) },
                    { label: p.status === "invited" ? "Withdraw invitation" : "Remove", tone: "danger", onSelect: () => { setReason(""); setReasonFor({ kind: "remove", person: p }); } },
                  ]}
                />
              )}
            </li>
          ))}
          {rows.filter((p) => p.status !== "removed").length === 0 && <li className="px-4 py-3 text-sm text-secondary-text">Nobody yet. Invite their first contact below.</li>}
        </ul>

        {canManage && portalOn && (
          <form onSubmit={invite} className="flex flex-col gap-3 rounded-xl border border-border-color p-4" noValidate aria-label="Invite someone">
            <h3 className="text-base font-semibold text-primary-text">Invite someone</h3>
            <Field label="Email address" required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="off" />
            <ComboField
              label="Role"
              required
              value={form.role}
              onChange={(role) => setForm({ ...form, role })}
              options={[
                { value: "admin", label: "Admin", hint: "Can invite and remove their own colleagues. Choose this for the first contact." },
                { value: "member", label: "Member", hint: "Can use the portal for their company." },
              ]}
            />
            {!hasAdmin && form.role !== "admin" && <p className="text-xs text-secondary-text">This company has no admin yet. Their first contact should be an admin, so they can invite their colleagues.</p>}
            <TextAreaField label="Message (optional)" rows={2} value={form.message} maxLength={500} onChange={(e) => setForm({ ...form, message: e.target.value })} />
            <div className="flex justify-end">
              <CTAButton type="main" size="md" buttonType="submit" icon={PlusIcon} disabled={!form.email.trim()} loading={mutate.isPending}>
                Send invitation
              </CTAButton>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}

