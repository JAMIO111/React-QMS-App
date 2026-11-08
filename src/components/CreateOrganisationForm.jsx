import { useRef, useState } from "react";
import Field from "./ui/Field";
import TimeZoneCombo from "./ui/TimeZoneCombo";
import { browserTimeZone } from "../lib/timeZones";
import { describeApiError, newIdempotencyKey } from "../lib/api-client";
import { useCreateOrganisation } from "../hooks/useQmsApi";
import CTAButton from "@/components/CTAButton";

/**
 * Creates an organisation through the API (the creator becomes its Owner). One idempotency key per
 * form, so a double click or a retry after a network blip cannot create two organisations.
 */
const CreateOrganisationForm = ({ onCreated }) => {
  const [name, setName] = useState("");
  const [siteName, setSiteName] = useState("Main site");
  const [siteCode, setSiteCode] = useState("MAIN");
  const [timeZone, setTimeZone] = useState(browserTimeZone);
  const idempotencyKey = useRef(newIdempotencyKey());
  const create = useCreateOrganisation();

  const submit = (e) => {
    e.preventDefault();
    create.mutate(
      {
        body: { name: name.trim(), site: { name: siteName.trim(), code: siteCode.trim() }, ...(timeZone ? { timeZone } : {}) },
        idempotencyKey: idempotencyKey.current,
      },
      { onSuccess: (organisation) => onCreated?.(organisation) }
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Create organisation">
      <Field
        label="Organisation name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        minLength={2}
        maxLength={100}
        placeholder="e.g. Acme Fabrication Ltd"
        autoFocus
      />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field
          className="sm:col-span-2"
          label="First site"
          value={siteName}
          onChange={(e) => setSiteName(e.target.value)}
          required
          maxLength={100}
        />
        <Field
          label="Site code"
          value={siteCode}
          onChange={(e) => setSiteCode(e.target.value.toUpperCase())}
          required
          pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,19}"
          title="1–20 letters, digits, - or _"
          hint="Short code, e.g. MAIN"
        />
      </div>
      <TimeZoneCombo value={timeZone} onChange={(zone) => setTimeZone(zone ?? "")} hint="Where your first site is. You can change it later." />
      {create.error && (
        <p role="alert" className="text-sm text-error-color">
          {describeApiError(create.error)}
        </p>
      )}
      <CTAButton
        buttonType="submit"
        disabled={create.isPending || name.trim().length < 2}
        type="main" size="lg" className="self-start">
        {create.isPending ? "Creating…" : "Create organisation"}
      </CTAButton>
    </form>
  );
};

export default CreateOrganisationForm;
