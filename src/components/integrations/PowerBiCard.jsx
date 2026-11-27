import { useState } from "react";
import MenuCard from "../ui/MenuCard";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import ComboField from "../ui/ComboField";
import CopyButton from "../ui/CopyButton";
import CTAButton from "@/components/CTAButton";
import { ChartNoAxesCombinedIcon, KeyRoundIcon, PlusIcon } from "@/components/icons";
import { TextAreaField } from "../master-data/shared";
import { usePermissions } from "../../hooks/useQmsApi";
import { useFirstInvoicePending } from "../../hooks/useSubscription";
import { useReportingDatasets, useReportingKeyMutation, useReportingKeys } from "../../hooks/useReporting";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { KEY_LIFETIMES, KEY_STATUS, lastUsedWords, powerQueryScript, reportingBaseUrl } from "../../lib/powerBi";

const Pill = ({ tone, children }) => {
  const cls = {
    success: "bg-success-color/15 text-success-color",
    warning: "bg-warning-color/15 text-warning-color",
    danger: "bg-error-color/15 text-error-color",
  }[tone];
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
};

/** A block of text to copy: a key, an address or a script. */
const Copyable = ({ label, text, multiline = false, testId }) => (
  <div className="flex flex-col gap-1">
    <span className="text-sm font-medium text-primary-text">{label}</span>
    <div className="flex flex-wrap items-start gap-2">
      {multiline ? (
        <pre data-testid={testId} className="max-h-72 min-w-0 flex-1 overflow-auto rounded-lg border border-border-color bg-secondary-bg px-3 py-2 font-mono text-xs text-primary-text">
          {text}
        </pre>
      ) : (
        <code data-testid={testId} className="min-w-0 flex-1 break-all rounded-lg border border-border-color bg-secondary-bg px-3 py-2 font-mono text-sm text-primary-text">
          {text}
        </code>
      )}
      <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} />
    </div>
  </div>
);

/** Make a key; the key itself is shown once, then only its first characters. */
const MakeKeyDialog = ({ onClose }) => {
  const mutate = useReportingKeyMutation();
  const { showToast } = useToast();
  const [name, setName] = useState("Power BI");
  const [days, setDays] = useState("365");
  const [made, setMade] = useState(null);
  const submit = (e) => {
    e.preventDefault();
    mutate.mutate(
      { action: "create", body: { name: name.trim(), days: Number(days) } },
      { onSuccess: setMade, onError: (err) => showToast({ type: "error", title: "The key could not be made", message: describeApiError(err) }) },
    );
  };
  if (made) {
    return (
      <Dialog title="Your reporting key" onClose={onClose} width="max-w-xl">
        <div className="flex flex-col gap-4">
          <Callout tone="warning" title="Copy the key now">
            It is shown only once. Fortress keeps just a fingerprint of it. If it is lost, revoke it and make a new one.
          </Callout>
          <Copyable label="Reporting key" text={made.secret} testId="report-key-secret" />
          <p className="text-sm text-secondary-text">
            In Power BI, choose <strong>Basic</strong> when it asks how to sign in: any user name (for example "powerbi") and this key as the password. It stands for you,
            so reports see only what you may see, and it can only read the reporting data. It stops working on {new Date(made.key.expiresAt).toLocaleDateString("en-GB")}, or sooner if you revoke it.
          </p>
          <div className="flex justify-end">
            <CTAButton type="main" size="md" onClick={onClose}>
              Done
            </CTAButton>
          </div>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog title="Make a reporting key" onClose={onClose}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <p className="text-sm text-secondary-text">
          A key lets a reporting tool such as Power BI read your data on a schedule, without a person signing in. It acts as you and can only read.
        </p>
        <Field label="Name" required value={name} maxLength={80} onChange={(e) => setName(e.target.value)} hint="What it is for, for example Power BI quality report." />
        <ComboField label="The key lasts" value={days} onChange={setDays} options={KEY_LIFETIMES} />
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton type="main" size="md" buttonType="submit" loading={mutate.isPending} disabled={!name.trim()}>
            Make the key
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Revoke a key. It closes at once and the key shows as revoked straight away (put back if Fortress refuses). */
const RevokeKeyDialog = ({ keyRow, onClose }) => {
  const mutate = useReportingKeyMutation();
  const { showToast } = useToast();
  const [reason, setReason] = useState("");
  const submit = (e) => {
    e.preventDefault();
    if (reason.trim().length < 3) return;
    onClose();
    mutate.mutate({ action: "revoke", id: keyRow.id, body: { reason: reason.trim() } }, { onError: (err) => showToast({ type: "error", title: "The key was not revoked", message: describeApiError(err) }) });
  };
  return (
    <Dialog title={`Revoke ${keyRow.name}`} onClose={onClose}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <p className="text-sm text-secondary-text">Any report using this key will stop refreshing at once. This cannot be undone; make a new key instead.</p>
        <TextAreaField label="Why" required value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} hint="For example: the report was replaced, or the key was shared by mistake." />
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton type="danger" size="md" buttonType="submit" disabled={reason.trim().length < 3}>
            Revoke the key
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** The address, the script for one dataset and the steps to connect Power BI. */
const ConnectDialog = ({ onClose }) => {
  const datasets = useReportingDatasets();
  const [dataset, setDataset] = useState("non_conformances");
  const list = datasets.data ?? [];
  const chosen = list.find((d) => d.key === dataset);
  const baseUrl = reportingBaseUrl();
  return (
    <Dialog title="Connect Power BI" onClose={onClose} width="max-w-3xl">
      <div className="flex flex-col gap-4">
        <ol className="list-decimal pl-5 text-sm text-primary-text">
          <li>Make a reporting key (above) and keep it to hand.</li>
          <li>
            In <strong>Power BI Desktop</strong>: Get data, then <strong>Blank query</strong>, then <strong>Advanced editor</strong>. Paste the script below.
          </li>
          <li>
            When it asks how to connect, choose <strong>Basic</strong>: any user name and the key as the password. Check the table loads, then close and apply.
          </li>
          <li>
            Publish the report. In the <strong>Power BI service</strong>, open the dataset's settings, enter the same Basic credentials and set a refresh schedule.
          </li>
        </ol>
        <Copyable label="Fortress address" text={baseUrl} testId="power-bi-address" />
        <ComboField
          label="Data"
          value={dataset}
          onChange={setDataset}
          options={list.map((d) => ({ value: d.key, label: d.title, hint: d.description }))}
          hint={chosen?.description}
        />
        <Copyable label="Power Query script" text={powerQueryScript({ baseUrl, dataset, columns: chosen?.columns ?? [] })} multiline testId="power-bi-script" />
        <Callout tone="info" title="Good to know">
          Power BI keeps its own copy of the data it imports, in the region its tenant uses. Costs are in your organisation currency, with credits (such as supplier recoveries)
          as negative amounts, so a sum is right. Each table has one row per record; link tables by their Fortress id columns.
        </Callout>
        <div className="flex justify-end">
          <CTAButton type="main" size="md" onClick={onClose}>
            Done
          </CTAButton>
        </div>
      </div>
    </Dialog>
  );
};

/** Settings → Integrations → Power BI and reporting (docs/reporting-api-plan.md). */
const PowerBiCard = () => {
  const { can } = usePermissions();
  const keys = useReportingKeys({ enabled: can("integrations.read") });
  const [making, setMaking] = useState(false);
  const [revoking, setRevoking] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const canManage = can("integrations.manage");
  const firstInvoicePending = useFirstInvoicePending({ enabled: can("subscription.read") });
  const data = keys.data?.data ?? [];
  const live = data.filter((k) => k.status === "active");
  const past = data.filter((k) => k.status !== "active");
  return (
    <MenuCard
      title="Power BI and reporting"
      subtitle="Let Power BI (or any reporting tool) read your non-conformances, costs and supplier quality data on a schedule. Keys are read-only and act as the person who made them."
      action={
        <div className="flex flex-wrap gap-2">
          <CTAButton type="secondary" size="default" icon={ChartNoAxesCombinedIcon} onClick={() => setConnecting(true)}>
            Connect Power BI
          </CTAButton>
          {canManage && (
            <CTAButton type="main" size="default" icon={PlusIcon} disabled={firstInvoicePending} onClick={() => setMaking(true)}>
              Make a key
            </CTAButton>
          )}
        </div>
      }>
      {firstInvoicePending && (
        <Callout tone="info" title="Reporting keys wait for your first invoice">
          Your first invoice has not been paid yet. Once it is, you can make a key to connect Power BI.
        </Callout>
      )}
      {keys.isError ? (
        <Callout tone="error" title="Reporting keys could not be loaded">
          Try again in a moment.
        </Callout>
      ) : !live.length ? (
        <p className="text-sm text-secondary-text">No reporting keys yet.{canManage ? " Make one to connect Power BI." : " Someone with a Controller seat can make one."}</p>
      ) : (
        <ul aria-label="Reporting keys" className="flex flex-col divide-y divide-border-color">
          {live.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-3 py-3">
              <KeyRoundIcon className="text-xl text-secondary-text" aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-primary-text">
                  {k.name} <span className="font-mono text-xs text-secondary-text">fqr_{k.keyPrefix}…</span>
                </span>
                <span className="text-xs text-secondary-text">
                  {k.mine ? "Acts as you" : "Acts as a colleague"} · expires {new Date(k.expiresAt).toLocaleDateString("en-GB")} · {lastUsedWords(k)}
                </span>
              </div>
              <Pill tone={KEY_STATUS[k.status].tone}>{KEY_STATUS[k.status].label}</Pill>
              {canManage && (
                <CTAButton type="neutral" size="default" onClick={() => setRevoking(k)} aria-label={`Revoke ${k.name}`}>
                  Revoke
                </CTAButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {past.length > 0 && (
        <details className="mt-3 text-sm text-secondary-text">
          <summary className="cursor-pointer">Past keys ({past.length})</summary>
          <ul aria-label="Past reporting keys" className="mt-2 flex flex-col gap-1">
            {past.map((k) => (
              <li key={k.id}>
                {k.name} · {KEY_STATUS[k.status].label.toLowerCase()}
                {k.revokedReason ? `: ${k.revokedReason}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
      {making && <MakeKeyDialog onClose={() => setMaking(false)} />}
      {revoking && <RevokeKeyDialog keyRow={revoking} onClose={() => setRevoking(null)} />}
      {connecting && <ConnectDialog onClose={() => setConnecting(false)} />}
    </MenuCard>
  );
};

export default PowerBiCard;
