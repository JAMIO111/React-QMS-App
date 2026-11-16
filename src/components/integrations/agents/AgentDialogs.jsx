import { useState } from "react";
import Dialog from "../../ui/Dialog";
import Field from "../../ui/Field";
import ComboField from "../../ui/ComboField";
import Callout from "../../ui/Callout";
import CTAButton from "@/components/CTAButton";
import { TextAreaField } from "../../master-data/shared";
import CopyButton from "../../ui/CopyButton";
import { useAgentMutation } from "../../../hooks/useAgents";
import { useToast } from "../../../contexts/ToastProvider";
import { describeApiError } from "../../../lib/api-client";
import { TOKEN_LIFETIMES } from "../../../lib/agents";

/** The token, once: copy it into the installer. Then the steps to install. */
const TokenResult = ({ result, onClose }) => (
  <div className="flex flex-col gap-4">
    <Callout tone="warning" title="Copy the token now">
      It is shown only once. If it is lost, cancel it and make a new one.
    </Callout>
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-primary-text">Registration token</span>
      <div className="flex flex-wrap items-center gap-2">
        <code data-testid="agent-token" className="min-w-0 flex-1 break-all rounded-lg border border-border-color bg-secondary-bg px-3 py-2 font-mono text-sm text-primary-text">
          {result.token}
        </code>
        <CopyButton text={result.token} label="Copy the token" />
      </div>
      <span className="text-xs text-secondary-text">Valid until {new Date(result.expiresAt).toLocaleString("en-GB")}, for one agent.</span>
    </div>
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-primary-text">Fortress address for the agent</span>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg border border-border-color bg-secondary-bg px-3 py-2 font-mono text-sm text-primary-text">{result.apiUrl}</code>
        <CopyButton text={result.apiUrl} label="Copy the address" />
      </div>
    </div>
    <ol className="list-decimal pl-5 text-sm text-primary-text">
      <li>
        {result.downloadUrl ? (
          <a href={result.downloadUrl} className="text-link-color hover:underline" target="_blank" rel="noreferrer">
            Download the Fortress Connector Agent
          </a>
        ) : (
          "Get the Fortress Connector Agent installer from your Fortress contact"
        )}{" "}
        on a Windows machine inside your network that can reach your databases.
      </li>
      <li>Run the installer as an administrator. When it asks, give it the address and the token above.</li>
      <li>The agent registers, then shows here as Online within a minute. It only ever connects out to Fortress; nothing connects in.</li>
    </ol>
    <div className="flex justify-end">
      <CTAButton type="main" size="md" onClick={onClose}>
        Done
      </CTAButton>
    </div>
  </div>
);

/** Add an agent (or, with `replaces`, make a token to reinstall an existing one on a new machine). */
export const AddAgentDialog = ({ replaces = null, onClose }) => {
  const mutate = useAgentMutation();
  const { showToast } = useToast();
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [hours, setHours] = useState("24");
  const [result, setResult] = useState(null);
  const submit = (e) => {
    e.preventDefault();
    const body = replaces
      ? { replacesAgentId: replaces.id, expiresHours: Number(hours) }
      : { name: name.trim(), location: location.trim() || null, expiresHours: Number(hours) };
    mutate.mutate(
      { action: "register", body },
      { onSuccess: setResult, onError: (err) => showToast({ type: "error", title: "The token could not be made", message: describeApiError(err) }) },
    );
  };
  return (
    <Dialog title={result ? "Install the agent" : replaces ? `Reinstall ${replaces.name}` : "Add a connector agent"} onClose={onClose} width="max-w-xl">
      {result ? (
        <TokenResult result={result} onClose={onClose} />
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <p className="text-sm text-secondary-text">
            {replaces
              ? "A new token lets the agent be installed on another machine. It keeps its name and history; the old machine's key stops working once the new one registers."
              : "A connector agent is a small Windows service you install inside your network. It connects out to Fortress, so no firewall ports need opening."}
          </p>
          {!replaces && (
            <>
              <Field label="Name" required value={name} maxLength={80} onChange={(e) => setName(e.target.value)} hint="For example the site or the server, such as Newcastle factory." />
              <TextAreaField label="Where it is installed" value={location} maxLength={200} onChange={(e) => setLocation(e.target.value)} hint="Optional: a server name or room, to help whoever looks after it." />
            </>
          )}
          <ComboField label="The token is valid for" value={hours} onChange={setHours} options={TOKEN_LIFETIMES} />
          <div className="flex justify-end gap-2">
            <CTAButton type="neutral" size="md" onClick={onClose}>
              Cancel
            </CTAButton>
            <CTAButton type="main" size="md" buttonType="submit" loading={mutate.isPending} disabled={!replaces && !name.trim()}>
              Make a token
            </CTAButton>
          </div>
        </form>
      )}
    </Dialog>
  );
};

export const RenameAgentDialog = ({ agent, onClose }) => {
  const mutate = useAgentMutation();
  const { showToast } = useToast();
  const [name, setName] = useState(agent.name);
  const [location, setLocation] = useState(agent.location ?? "");
  const submit = (e) => {
    e.preventDefault();
    onClose();
    mutate.mutate(
      { action: "rename", id: agent.id, body: { name: name.trim(), location: location.trim() || null } },
      { onError: (err) => showToast({ type: "error", title: "Not renamed", message: describeApiError(err) }) },
    );
  };
  return (
    <Dialog title={`Rename ${agent.name}`} onClose={onClose}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field label="Name" required value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <TextAreaField label="Where it is installed" value={location} maxLength={200} onChange={(e) => setLocation(e.target.value)} />
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton type="main" size="md" buttonType="submit" disabled={!name.trim()}>
            Save
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

export const RevokeAgentDialog = ({ agent, onClose }) => {
  const mutate = useAgentMutation();
  const { showToast } = useToast();
  const [reason, setReason] = useState("");
  const submit = (e) => {
    e.preventDefault();
    mutate.mutate(
      { action: "revoke", id: agent.id, body: { reason: reason.trim() } },
      { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not revoked", message: describeApiError(err) }) },
    );
  };
  return (
    <Dialog title={`Revoke ${agent.name}?`} onClose={onClose}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <p className="text-sm text-secondary-text">
          Its key stops working on its next request and anything waiting for it is cancelled. This cannot be undone: to use the machine again,
          register a new agent.
        </p>
        <TextAreaField label="Why?" required value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton type="danger" size="md" buttonType="submit" loading={mutate.isPending} disabled={reason.trim().length < 3}>
            Revoke
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};
