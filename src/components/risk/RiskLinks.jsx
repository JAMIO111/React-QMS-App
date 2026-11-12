import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { LinkIcon, PencilIcon, PlusIcon, XIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { apiFetch, describeApiError } from "../../lib/api-client";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { useToast } from "../../contexts/ToastProvider";
import { useDebouncedSearch } from "../../hooks/useDebouncedSearch";
import { usePartFamilies } from "../../hooks/useProcessControl";
import { useRiskMutation } from "../../hooks/useRisk";
import { LINK_KINDS, linkKindLabel, linkPath, linksBody, linkWords, sameLink } from "../../lib/risk";
import { FormError } from "../master-data/shared";
import { MachinePicker, NcrPicker, PartPicker, PartyPicker, RemoteComboBox } from "../ncr/Pickers";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";

/** Search a register the shared pickers do not cover (8Ds, audit findings, documents, part families). */
const SEARCH = {
  capa: { path: "/capas", params: { stage: "all" }, label: (r) => ({ id: r.id, name: `${r.reference} · ${r.title}` }) },
  audit_finding: { path: "/audit-findings", params: {}, label: (r) => ({ id: r.id, name: `${r.reference} · ${r.title}` }) },
  document: { path: "/documents", params: {}, label: (r) => ({ id: r.id, name: `${r.number} · ${r.title}` }) },
};
const SearchPicker = ({ kind, value, onChange, label }) => {
  const { organisationId } = useOrganisation();
  const [q, setSearch] = useDebouncedSearch();
  const conf = SEARCH[kind];
  const found = useQuery({
    queryKey: ["api", "org", organisationId, "risk", "link-search", kind, q],
    queryFn: () => apiFetch(`${conf.path}?${new URLSearchParams({ ...conf.params, ...(q ? { q } : {}), page: "1", pageSize: "10" })}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
  return (
    <RemoteComboBox
      label={label}
      placeholder="Search by number or title…"
      value={value}
      onChange={onChange}
      items={(found.data?.data ?? []).map(conf.label)}
      isFetching={found.isFetching}
      onSearch={setSearch}
    />
  );
};
const FamilyPicker = ({ value, onChange, label }) => {
  const [q, setSearch] = useDebouncedSearch();
  const families = usePartFamilies({ q });
  return (
    <RemoteComboBox
      label={label}
      placeholder="Search a part family…"
      value={value}
      onChange={onChange}
      items={(families.data?.items ?? []).map((f) => ({ id: f.id, name: f.name, hint: f.code }))}
      isFetching={families.isFetching}
      onSearch={setSearch}
    />
  );
};

/** One picker for the chosen kind; `onPick({ id, name })` with what was chosen. */
const TargetPicker = ({ kind, onPick }) => {
  const [value, setValue] = useState(null);
  const label = linkKindLabel(kind);
  const pick = (id, name) => {
    setValue(id);
    if (id) onPick({ id, name });
  };
  const props = { label, value, onChange: (id, option) => pick(id, option?.name) };
  switch (kind) {
    case "ncr":
      return <NcrPicker {...props} />;
    case "supplier":
      return <PartyPicker kind="suppliers" {...props} />;
    case "part":
      return <PartPicker {...props} />;
    case "machine":
      return <MachinePicker {...props} />;
    case "part_family":
      return <FamilyPicker {...props} />;
    default:
      return <SearchPicker kind={kind} {...props} />;
  }
};

/** Change everything a risk is linked to. The record it was raised from cannot be removed. */
export const LinksDialog = ({ risk, onClose }) => {
  const mutation = useRiskMutation();
  const { showToast } = useToast();
  const [links, setLinks] = useState(risk.links);
  const [kind, setKind] = useState("part");
  const [code, setCode] = useState("");
  const isOrigin = (l) => risk.origin && l.kind === risk.origin.kind && l.id === risk.origin.id;
  const add = (link) => setLinks((current) => (current.some((l) => sameLink(l, link)) ? current : [...current, link]));
  const save = () =>
    mutation.mutate(
      { action: "setLinks", id: risk.id, body: { links: linksBody(links) } },
      { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Links not saved", message: describeApiError(err) }) },
    );
  return (
    <Dialog title={`What ${risk.reference} is linked to`} onClose={onClose} width="max-w-2xl">
      <div className="flex flex-col gap-4">
        {links.length === 0 ? (
          <p className="text-sm text-secondary-text">Nothing linked yet.</p>
        ) : (
          <ul aria-label="Links" className="flex flex-col gap-2">
            {links.map((l) => (
              <li key={`${l.kind}:${l.id ?? l.code}`} className="flex items-center gap-2 rounded-lg border border-border-color bg-primary-bg px-3 py-2 text-sm">
                <span className="text-xs font-medium uppercase tracking-wide text-secondary-text">{linkKindLabel(l.kind)}</span>
                <span className="min-w-0 flex-1 truncate text-primary-text">{linkWords(l)}</span>
                {isOrigin(l) ? (
                  <span className="text-xs text-secondary-text">Raised from this</span>
                ) : (
                  <button type="button" aria-label={`Remove ${linkWords(l)}`} className="rounded p-1 text-secondary-text hover:text-error-color" onClick={() => setLinks((c) => c.filter((x) => !sameLink(x, l)))}>
                    <XIcon className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-3 rounded-xl border border-dashed border-border-color p-3 sm:grid-cols-[12rem_1fr]">
          <ComboField label="Add a link to" value={kind} onChange={(v) => setKind(v ?? "part")} options={LINK_KINDS.map(({ value, label }) => ({ value, label }))} clearable={false} sort={false} />
          {kind === "operation_code" ? (
            <div className="flex items-end gap-2">
              <Field label="Operation code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={40} className="flex-1" />
              <CTAButton
                type="neutral"
                size="md"
                icon={PlusIcon}
                disabled={!code.trim()}
                onClick={() => {
                  add({ kind: "operation_code", id: null, code: code.trim(), reference: code.trim(), name: null, readable: true });
                  setCode("");
                }}
              >
                Add
              </CTAButton>
            </div>
          ) : (
            <TargetPicker key={kind} kind={kind} onPick={({ id, name }) => add({ kind, id, code: null, reference: name ?? null, name: null, readable: true })} />
          )}
        </div>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton type="main" size="md" loading={mutation.isPending} onClick={save}>
            Save links
          </CTAButton>
        </div>
      </div>
    </Dialog>
  );
};

/** A list of links, each to its record's page when it has one and the reader may open it. */
export const LinkList = ({ links, origin, label = "Linked records" }) => (
  <ul aria-label={label} className="flex flex-wrap gap-2">
    {links.map((l) => {
      const to = l.readable ? linkPath(l) : null;
      const words = linkWords(l);
      const chip = (
        <>
          <span className="text-secondary-text">{linkKindLabel(l.kind)}</span> <span className="text-primary-text">{words}</span>
          {origin && l.kind === origin.kind && l.id === origin.id && <span className="text-secondary-text"> · raised from this</span>}
        </>
      );
      return (
        <li key={`${l.kind}:${l.id ?? l.code}`} className="rounded-full border border-border-color bg-primary-bg px-3 py-1 text-sm">
          {to ? (
            <Link to={to} className="hover:underline">
              {chip}
            </Link>
          ) : (
            chip
          )}
        </li>
      );
    })}
  </ul>
);

/** The risk page's card: where it came from and what it is linked to. */
export const LinksCard = ({ risk }) => {
  const [open, setOpen] = useState(false);
  return (
    <MenuCard
      title="Links"
      subtitle="The records this risk is about. They stay where they are; each opens to people who may read it."
      action={
        risk.canEdit && (
          <CTAButton type="secondary" icon={risk.links.length ? PencilIcon : LinkIcon} onClick={() => setOpen(true)}>
            {risk.links.length ? "Change links" : "Link records"}
          </CTAButton>
        )
      }
    >
      {risk.links.length === 0 ? <p className="text-sm text-secondary-text">Not linked to anything yet.</p> : <LinkList links={risk.links} origin={risk.origin} />}
      {open && <LinksDialog risk={risk} onClose={() => setOpen(false)} />}
    </MenuCard>
  );
};
