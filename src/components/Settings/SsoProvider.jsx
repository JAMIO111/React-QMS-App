import { useState } from "react";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import CopyButton from "../ui/CopyButton";
import SlidingToggle from "../ui/SlidingToggle";
import CTAButton from "@/components/CTAButton";
import { TextAreaField } from "../master-data/shared";
import { ExternalLinkIcon } from "@/components/icons";
import { useSsoMutation } from "../../hooks/useSecurity";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { whenWords } from "../../lib/security";

/** The text of a chosen file (FileReader works in every browser and in tests). */
const readText = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });

const Value = ({ label, value }) => (
  <>
    <dt className="text-secondary-text">{label}</dt>
    <dd className="break-all font-mono">{value}</dd>
    <dd>
      <CopyButton text={value} label={`Copy the ${label.toLowerCase()}`} />
    </dd>
  </>
);

/**
 * The company's sign-in (docs/sso-plan.md SS2), the second half of the Single sign-on card: what the company's IT enters for Fortress, the
 * metadata they give back (an address or the file), Test sign-in, and Disconnect. Supabase reads and checks the metadata; Fortress only keeps
 * which provider it is, its domains and who connected it.
 */
export default function SsoProvider({ sso, canManage }) {
  const mutate = useSsoMutation();
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const provider = sso.provider;
  const verified = sso.domains.filter((d) => d.state === "verified" || d.state === "failing");

  return (
    <section className="flex flex-col gap-3 border-t border-border-color pt-4" aria-label="Your company's sign-in">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-primary-text">Your company&apos;s sign-in</h3>
        <p className="text-sm text-secondary-text">
          Connect the system your company signs in with (Microsoft Entra ID, Okta, Google Workspace, ADFS or any SAML 2.0 provider). People at your
          verified domains can then choose <strong>Sign in with your company account</strong>.
        </p>
      </div>

      {!sso.available && (
        <Callout tone="info" title="Not available yet">
          Single sign-on cannot be connected on this Fortress server yet. Your domains are kept; you can connect your sign-in once it is switched on.
        </Callout>
      )}

      {sso.serviceProvider && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-primary-text">Give these to your IT team. In their system, Fortress is a new SAML application with:</p>
          <dl className="grid gap-2 rounded-lg bg-secondary-bg p-3 text-sm sm:grid-cols-[auto_1fr_auto] sm:items-center">
            <Value label="Entity ID" value={sso.serviceProvider.entityId} />
            <Value label="Reply URL (ACS)" value={sso.serviceProvider.acsUrl} />
          </dl>
          <p className="text-xs text-secondary-text">
            The name ID should be the person&apos;s email address. Fortress also reads their first name, surname and display name when they are sent.{" "}
            <a href={sso.serviceProvider.metadataDownloadUrl} className="text-link-color underline" target="_blank" rel="noreferrer">
              Download Fortress&apos;s metadata
            </a>{" "}
            if their system asks for a file instead.
          </p>
        </div>
      )}

      {provider ? (
        <section className="flex flex-col gap-2 rounded-xl border border-border-color p-3" aria-label="Connected sign-in">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-success-color/15 px-2 py-0.5 text-xs font-medium text-success-color">Connected</span>
            <span className="break-all font-mono text-sm text-primary-text">{provider.entityId ?? "Identity provider"}</span>
          </div>
          <p className="text-sm text-secondary-text">
            Connected {whenWords(provider.createdAt)}
            {provider.createdBy ? ` by ${provider.createdBy}` : ""}. Metadata {provider.metadataKind === "url" ? `read from ${provider.metadataUrl}` : "from an uploaded file"}.
            {provider.domains.length ? ` For ${provider.domains.join(", ")}.` : " No verified domain is linked: verify one above."}
          </p>
          {provider.lastError && (
            <Callout tone="warning" title="The domains could not be sent to the sign-in service">
              {provider.lastError}. They are sent again at the next change; or choose Replace metadata to send everything now.
            </Callout>
          )}
          <div className="flex flex-wrap gap-2">
            <CTAButton type="secondary" size="default" icon={ExternalLinkIcon} to={`/sso?provider=${provider.supabaseProviderId}`} target="_blank" rel="noreferrer">
              Test sign-in
            </CTAButton>
            {canManage && sso.available && (
              <>
                <CTAButton type="neutral" size="default" onClick={() => setEditing(true)}>Replace metadata</CTAButton>
                <CTAButton type="danger" size="default" onClick={() => setDisabling(true)}>Disconnect</CTAButton>
              </>
            )}
          </div>
        </section>
      ) : (
        canManage &&
        sso.available &&
        (verified.length ? (
          <CTAButton type="main" size="default" className="self-start" onClick={() => setEditing(true)}>
            Connect your sign-in
          </CTAButton>
        ) : (
          <p className="text-sm text-secondary-text">Verify a domain above first.</p>
        ))
      )}

      {sso.previousProviders.length > 0 && (
        <details className="text-sm text-secondary-text">
          <summary className="cursor-pointer">Earlier connections ({sso.previousProviders.length})</summary>
          <ul className="mt-1 flex flex-col gap-1" aria-label="Earlier connections">
            {sso.previousProviders.map((p) => (
              <li key={p.id}>
                {p.entityId ?? "Identity provider"}: disconnected {whenWords(p.disabledAt)}
                {p.disabledBy ? ` by ${p.disabledBy}` : ""}. {p.disabledReason}
              </li>
            ))}
          </ul>
        </details>
      )}

      {editing && <MetadataDialog replacing={!!provider} onClose={() => setEditing(false)} mutate={mutate} showToast={showToast} />}
      {disabling && <DisconnectDialog onClose={() => setDisabling(false)} mutate={mutate} showToast={showToast} />}
    </section>
  );
}

function MetadataDialog({ replacing, onClose, mutate, showToast }) {
  const [how, setHow] = useState("url");
  const [url, setUrl] = useState("");
  const [xml, setXml] = useState(null);
  const [problem, setProblem] = useState(null);

  const readFile = async (file) => {
    setProblem(null);
    if (!file) return setXml(null);
    if (file.size > 256 * 1024) return setProblem("That file is too large to be SAML metadata.");
    const text = await readText(file);
    if (!/EntityDescriptor/.test(text)) return setProblem("That file is not SAML metadata: ask your IT team for the federation metadata XML.");
    setXml({ name: file.name, text });
  };

  const submit = (e) => {
    e.preventDefault();
    setProblem(null);
    if (how === "url" && !/^https:\/\/\S+$/.test(url.trim())) return setProblem("Paste the metadata address your IT team gave you. It starts with https://.");
    if (how === "file" && !xml) return setProblem("Choose the metadata file.");
    mutate.mutate(
      { action: "saveProvider", body: how === "url" ? { metadataUrl: url.trim() } : { metadataXml: xml.text } },
      {
        onSuccess: () => {
          showToast({ type: "success", title: replacing ? "Metadata replaced" : "Sign-in connected", message: "Use Test sign-in to try it." });
          onClose();
        },
        onError: (error) => setProblem(describeApiError(error)),
      },
    );
  };

  return (
    <Dialog title={replacing ? "Replace the metadata" : "Connect your company's sign-in"} onClose={onClose}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-secondary-text">
          Your IT team gets this from their system once they have added Fortress (for Microsoft Entra ID: the App Federation Metadata URL).
        </p>
        <SlidingToggle
          ariaLabel="How the metadata is given"
          options={[
            { value: "url", label: "An address" },
            { value: "file", label: "A file" },
          ]}
          value={how}
          onChange={setHow}
        />
        {how === "url" ? (
          <Field label="Metadata address" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://login.example.com/…/federationmetadata.xml" />
        ) : (
          <label className="flex flex-col gap-1 text-sm font-medium text-primary-text" data-required>
            Metadata file
            <input type="file" accept=".xml,application/xml,text/xml" aria-required="true" onChange={(e) => readFile(e.target.files?.[0])} className="text-sm" />
            {xml && <span className="text-xs font-normal text-secondary-text">{xml.name}</span>}
          </label>
        )}
        {problem && <Callout tone="error" role="alert">{problem}</Callout>}
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton type="main" size="md" buttonType="submit" loading={mutate.isPending} loadingText="Connecting">
            {replacing ? "Replace" : "Connect"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
}

function DisconnectDialog({ onClose, mutate, showToast }) {
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState(null);
  const submit = (e) => {
    e.preventDefault();
    if (reason.trim().length < 3) return setProblem("Say why it is being disconnected.");
    mutate.mutate(
      { action: "disableProvider", body: { reason: reason.trim() } },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Disconnected", message: "People sign in with their email and password again." });
          onClose();
        },
        onError: (error) => setProblem(describeApiError(error)),
      },
    );
  };
  return (
    <Dialog title="Disconnect your company's sign-in?" onClose={onClose}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-secondary-text">
          Nobody can sign in with their company account until a sign-in is connected again. Your verified domains are kept.
        </p>
        <TextAreaField label="Why?" required value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        {problem && <Callout tone="error" role="alert">{problem}</Callout>}
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton type="danger" size="md" buttonType="submit" loading={mutate.isPending}>Disconnect</CTAButton>
        </div>
      </form>
    </Dialog>
  );
}
