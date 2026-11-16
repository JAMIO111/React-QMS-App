import { useState } from "react";
import { useAgentReleaseMutation, usePlatformAgentReleases } from "../../hooks/usePlatform";
import { Card, Panel, Pill, Table } from "./Panels";
import { day } from "./format";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import CTAButton from "@/components/CTAButton";
import { TextAreaField } from "../master-data/shared";
import { describeApiError } from "../../lib/api-client";
import { platformLabel, sizeWords } from "../../lib/agents";

/** Paste the manifest and signature that connector-agent/release/sign-release.mjs printed; the API checks the signature before anything is stored. */
const PublishForm = () => {
  const mutate = useAgentReleaseMutation();
  const [manifest, setManifest] = useState("");
  const [signature, setSignature] = useState("");
  const [done, setDone] = useState(null);
  const submit = (e) => {
    e.preventDefault();
    setDone(null);
    mutate.mutate(
      { action: "publish", body: { manifest: manifest.trim(), signature: signature.trim() } },
      {
        onSuccess: (r) => {
          setDone(r);
          setManifest("");
          setSignature("");
        },
      },
    );
  };
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      <TextAreaField label="Manifest" required rows={5} value={manifest} onChange={(e) => setManifest(e.target.value)} hint="The JSON exactly as sign-release.mjs printed it: a changed character breaks the signature." />
      <TextAreaField label="Signature" required rows={2} value={signature} onChange={(e) => setSignature(e.target.value)} />
      {mutate.error && (
        <Callout tone="error" title="Not published">
          {describeApiError(mutate.error)}
        </Callout>
      )}
      {done && <Callout tone="success">Published, signed with key {done.keyId}. Organisations can now approve it for their agents.</Callout>}
      <CTAButton type="main" size="md" buttonType="submit" className="self-start" loading={mutate.isPending} loadingText="Checking" disabled={!manifest.trim() || !signature.trim()}>
        Publish
      </CTAButton>
    </form>
  );
};

const WithdrawDialog = ({ release, onClose }) => {
  const mutate = useAgentReleaseMutation();
  const [reason, setReason] = useState("");
  const submit = (e) => {
    e.preventDefault();
    mutate.mutate({ action: "withdraw", id: release.id, body: { reason: reason.trim() } }, { onSuccess: onClose });
  };
  return (
    <Dialog title={`Withdraw version ${release.version} (${platformLabel(release.platform)})?`} onClose={onClose}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <p className="text-sm text-secondary-text">
          No organisation can approve it any more, and updates waiting for it are cancelled. Agents already on it keep running it. This cannot be undone.
        </p>
        <TextAreaField label="Why?" required value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        {mutate.error && <Callout tone="error">{describeApiError(mutate.error)}</Callout>}
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton type="danger" size="md" buttonType="submit" loading={mutate.isPending} disabled={reason.trim().length < 3}>
            Withdraw
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Connector agent releases (docs/connector-agent-plan.md AG6b): publish a signed release, see who runs what, withdraw a bad one. */
const AgentReleasesPanel = () => {
  const query = usePlatformAgentReleases();
  const [withdrawing, setWithdrawing] = useState(null);
  return (
    <Panel query={query}>
      {(r) => (
        <div className="flex flex-col gap-4">
          {!r.keysConfigured ? (
            <Callout tone="warning" title="No release key is configured">
              AGENT_RELEASE_KEYS is not set on the API, so nothing can be published. Make a key with connector-agent/release/make-release-key.mjs and set its public half there
              (and in the agent&apos;s built-in keys).
            </Callout>
          ) : (
            <Card title="Publish a release" subtitle={`Signatures are checked against key ${r.keyIds.join(", ")}. Each agent checks them again against the keys built into it.`}>
              <PublishForm />
            </Card>
          )}
          <Card title="Releases" subtitle="Newest first, with how many active agents run each one.">
            <Table caption="Releases" head={["Version", "Platform", "Size", "Published", "Agents on it", "Status", ""]} empty={r.data.length === 0 ? "Nothing has been published yet." : null}>
              {r.data.map((x) => (
                <tr key={x.id} className="border-b border-border-color align-top last:border-0">
                  <td className="py-2 pr-3 text-primary-text">
                    {x.version}
                    {x.notes && <span className="block text-xs text-secondary-text">{x.notes}</span>}
                  </td>
                  <td className="py-2 pr-3 text-primary-text">{platformLabel(x.platform)}</td>
                  <td className="py-2 pr-3 text-primary-text">{sizeWords(x.sizeBytes)}</td>
                  <td className="py-2 pr-3 text-primary-text">
                    {day(x.publishedAt)}
                    {x.publishedBy && <span className="block text-xs text-secondary-text">{x.publishedBy}</span>}
                  </td>
                  <td className="py-2 pr-3 text-primary-text">{x.agentsOn}</td>
                  <td className="py-2 pr-3">
                    {x.status === "published" ? <Pill tone="good">Published</Pill> : <Pill tone="bad">Withdrawn</Pill>}
                    {x.withdrawnReason && <span className="block text-xs text-secondary-text">{x.withdrawnReason}</span>}
                  </td>
                  <td className="py-2 text-right">
                    {x.status === "published" && (
                      <CTAButton type="neutral" size="default" onClick={() => setWithdrawing(x)}>
                        Withdraw
                      </CTAButton>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
          {withdrawing && <WithdrawDialog release={withdrawing} onClose={() => setWithdrawing(null)} />}
        </div>
      )}
    </Panel>
  );
};

export default AgentReleasesPanel;
