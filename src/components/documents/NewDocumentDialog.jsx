import { useState } from "react";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useCustomFieldPeople } from "../../hooks/useCustomFields";
import { useDocumentMutation, useDocumentTypes } from "../../hooks/useDocuments";
import { useAuth } from "../../contexts/AuthProvider";
import { CONTENT_KINDS } from "../../lib/documents";
import { FormError } from "../master-data/shared";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import Switch from "../ui/Switch";

/**
 * A new document and its first draft. Numbered from its type (`SOP-001`), or, when bringing an existing document across, with the number
 * and current revision letter typed in. Whether it is a file or written here is fixed once created.
 */
const NewDocumentDialog = ({ onClose, onCreated }) => {
  const types = useDocumentTypes();
  const people = useCustomFieldPeople();
  const { user } = useAuth();
  const mutation = useDocumentMutation();
  const { showToast } = useToast();
  const [typeId, setTypeId] = useState(null);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState(null);
  const [ownerId, setOwnerId] = useState(null);
  const [description, setDescription] = useState("");
  const [existing, setExisting] = useState(false);
  const [number, setNumber] = useState("");
  const [letter, setLetter] = useState("");
  const [external, setExternal] = useState(false);
  const [issuer, setIssuer] = useState("");
  const [reference, setReference] = useState("");

  const typeList = types.data?.data ?? [];
  const typeOptions = typeList.map((t) => ({ value: t.id, label: t.name, hint: t.prefix }));
  const chosenType = typeList.find((t) => t.id === typeId);
  const personOptions = (people.data ?? []).map((p) => ({ value: p.id, label: p.name }));
  const owner = ownerId ?? user?.id ?? null;
  const letterOk = /^[A-Za-z]{1,3}$/.test(letter.trim());
  const contentKind = external ? "file" : kind;
  const ready = typeId && title.trim() && contentKind && (!existing || (number.trim() && letterOk)) && (!external || issuer.trim());

  const chooseType = (id) => {
    setTypeId(id);
    const t = typeList.find((x) => x.id === id);
    if (t && !kind) setKind(t.contentHint);
    if (t?.prefix === "EXT") setExternal(true);
  };

  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    const body = { typeId, title: title.trim(), contentKind, description: description.trim() || null };
    if (owner) body.ownerId = owner;
    if (external) Object.assign(body, { origin: "external", issuer: issuer.trim(), ...(reference.trim() ? { externalReference: reference.trim() } : {}) });
    if (existing) Object.assign(body, { number: number.trim(), startLetter: letter.trim().toUpperCase() });
    mutation.mutate(
      { action: "createDocument", body },
      {
        onSuccess: (doc) => {
          onCreated?.(doc);
          onClose();
        },
        onError: (err) => showToast({ type: "error", title: "Not created", message: describeApiError(err) }),
      },
    );
  };

  return (
    <Dialog title="New document" onClose={onClose} width="max-w-2xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <ComboField label="Type" required value={typeId} onChange={chooseType} options={typeOptions} placeholder="Choose a type" hint={chosenType && !existing ? `Numbered ${chosenType.prefix}-…` : undefined} />
          <ComboField
            label="Content"
            required
            value={contentKind}
            onChange={setKind}
            options={CONTENT_KINDS}
            disabled={external}
            placeholder="A file, or written here"
            hint={external ? "An external document is always a file" : "Fixed once the document is created"}
          />
        </div>
        <Switch checked={external} onChange={(e) => setExternal(e.target.checked)}>
          External: issued by someone else (a customer specification, a standard, a supplier's manual)
        </Switch>
        {external && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Issued by" value={issuer} onChange={(e) => setIssuer(e.target.value)} required maxLength={200} placeholder="e.g. Acme Ltd, ISO" />
            <Field label="Their reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} placeholder="e.g. ACS-1001" hint="Optional: the number they give it" />
          </div>
        )}
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="e.g. Control of nonconforming product" />
        <ComboField label="Owner" value={owner} onChange={setOwnerId} options={personOptions} placeholder="Who looks after it" hint="Whoever keeps it up to date. You, unless you choose someone else." />
        <Field label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} hint="Optional: scope or purpose" />
        <Switch checked={existing} onChange={(e) => setExisting(e.target.checked)}>
          Bringing an existing document across
        </Switch>
        {existing && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Its number" value={number} onChange={(e) => setNumber(e.target.value)} required maxLength={40} placeholder="e.g. SOP-014" hint="As it is known today" />
            <Field label="Its current revision letter" value={letter} onChange={(e) => setLetter(e.target.value.toUpperCase())} required maxLength={3} placeholder="e.g. C" hint="The first revision issued here takes this letter" />
          </div>
        )}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!ready || mutation.isPending} loading={mutation.isPending}>
            Create document
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

export default NewDocumentDialog;
