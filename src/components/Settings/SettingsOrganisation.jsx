import { useEffect, useState } from "react";
import Field from "../ui/Field";
import SitesManager from "./SitesManager";
import ThemeColourPicker from "./ThemeColourPicker";
import OrganisationLogo from "./OrganisationLogo";
import ProductionSettings from "./ProductionSettings";
import RequireMfaSetting from "./RequireMfaSetting";
import { describeApiError, API_URL } from "../../lib/api-client";
import {
  useOrganisationDetails,
  usePermissions,
  useUpdateOrganisation,
} from "../../hooks/useQmsApi";
import MenuCard from "../ui/MenuCard";
import { useToast } from "../../contexts/ToastProvider";
import LoadingScreen from "../ui/LoadingScreen";
import CTAButton from "@/components/CTAButton";

/** Shown instead of a section when the API cannot be reached. */
export const ApiUnavailable = ({ error }) => (
  <MenuCard
    as="div"
    role="alert"
    title="Organisation settings need the QMS API">
    <p className="text-sm text-secondary-text">
      {error?.code === "api_unreachable"
        ? `The API could not be reached at ${API_URL}. Start it with "npm run api:dev" (see api/README.md) or set VITE_API_URL.`
        : describeApiError(error)}
    </p>
  </MenuCard>
);

const toForm = (org) => ({
  name: org?.name ?? "",
  legalName: org?.legalName ?? "",
  country: org?.country ?? "",
  baseCurrency: org?.settings.baseCurrency ?? "",
  vatPercent: org ? String(Math.round(org.settings.vatRate * 10000) / 100) : "",
  ncrReferencePrefix: org?.settings.ncrReferencePrefix ?? "",
  reason: "",
});

const SettingsOrganisation = () => {
  const { data: org, isLoading, error } = useOrganisationDetails();
  const { can } = usePermissions();
  const update = useUpdateOrganisation();
  const { showToast } = useToast();
  const [form, setForm] = useState(toForm(org));
  const canManage = can("organisation.manage");

  // Reset the form only when the fields it edits change, so saving the theme colour does not
  // discard unsaved edits here.
  const formSource = JSON.stringify(toForm(org));
  useEffect(() => setForm(JSON.parse(formSource)), [formSource]);

  if (isLoading)
    return <LoadingScreen />;
  if (error) return <ApiUnavailable error={error} />;

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const vatRate = Number(form.vatPercent) / 100;

  const submit = (e) => {
    e.preventDefault();
    update.mutate(
      {
        body: {
          name: form.name.trim(),
          // Only what changed, so saving the currency does not touch the legal details.
          ...(form.legalName.trim() !== (org.legalName ?? "") ? { legalName: form.legalName.trim() || null } : {}),
          ...(form.country.trim().toUpperCase() !== (org.country ?? "") ? { country: form.country.trim().toUpperCase() || null } : {}),
          settings: {
            baseCurrency: form.baseCurrency.trim(),
            vatRate: Math.round(vatRate * 10000) / 10000,
            ncrReferencePrefix: form.ncrReferencePrefix.trim(),
          },
        },
        reason: form.reason.trim() || undefined,
      },
      {
        onSuccess: () =>
          showToast({
            type: "success",
            title: "Saved",
            message: "Organisation settings updated.",
          }),
      },
    );
  };

  return (
    <div className="flex flex-col gap-5 w-full">
      <div>
        <h2 className="text-primary-text text-2xl font-semibold">
          Organisation
        </h2>
        <p className="text-secondary-text text-sm">
          {canManage
            ? "Details, defaults, sites and departments."
            : "You can view these settings; an administrator can change them."}
        </p>
      </div>

      <MenuCard
        as="form"
        onSubmit={submit}
        aria-label="Organisation details"
        title="Details"
        subtitle="Name, currency, VAT and NCR numbering"
        bodyClassName="flex flex-col gap-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field
            label="Name"
            value={form.name}
            onChange={set("name")}
            disabled={!canManage}
            required
            minLength={2}
            maxLength={100}
          />
          <Field
            label="Legal name"
            value={form.legalName}
            onChange={set("legalName")}
            disabled={!canManage}
            maxLength={200}
            hint="Used on documents and invoices"
          />
          <Field
            label="Country"
            value={form.country}
            onChange={(e) => setForm((f) => ({ ...f, country: e.target.value.toUpperCase() }))}
            disabled={!canManage}
            pattern="[A-Za-z]{2}"
            maxLength={2}
            hint="Two-letter ISO code, e.g. GB"
          />
          <Field
            label="Identifier"
            value={org.slug}
            disabled
            hint="Used in links; set when the organisation was created"
          />
          <Field
            label="Base currency"
            value={form.baseCurrency}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                baseCurrency: e.target.value.toUpperCase(),
              }))
            }
            disabled={!canManage}
            required
            pattern="[A-Za-z]{3}"
            maxLength={3}
            hint="ISO code, e.g. GBP"
          />
          <Field
            label="VAT rate (%)"
            type="number"
            step="0.01"
            min="0"
            max="99.99"
            value={form.vatPercent}
            onChange={set("vatPercent")}
            disabled={!canManage}
            required
          />
          <Field
            label="NCR reference prefix"
            value={form.ncrReferencePrefix}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                ncrReferencePrefix: e.target.value.toUpperCase(),
              }))
            }
            disabled={!canManage}
            required
            pattern="[A-Za-z0-9]{1,10}"
            maxLength={10}
            hint="Prefix for new NCR numbers, e.g. NCM"
          />
          {canManage && (
            <Field
              label="Reason for change (optional)"
              value={form.reason}
              onChange={set("reason")}
              maxLength={500}
              hint="Recorded in the audit trail"
            />
          )}
        </div>
        {update.error && (
          <p role="alert" className="text-sm text-error-color">
            {describeApiError(update.error)}
          </p>
        )}
        {canManage && (
          <CTAButton
            buttonType="submit"
            disabled={update.isPending} loading={update.isPending}
            type="main" size="lg" className="self-start">
            {update.isPending ? "Saving…" : "Save changes"}
          </CTAButton>
        )}
      </MenuCard>

      <OrganisationLogo
        logoPath={org.settings.logoPath ?? null}
        canManage={canManage}
      />

      <ThemeColourPicker
        value={org.settings.themeColour ?? "purple"}
        canManage={canManage}
      />

      <RequireMfaSetting
        value={!!org.settings.requireMfa}
        canManage={canManage}
      />

      <ProductionSettings
        settings={{
          useLotsAndSerials: org.settings.useLotsAndSerials ?? true,
          allowInlineOrders: !!org.settings.allowInlineOrders,
          requireProductionOrder: !!org.settings.requireProductionOrder,
        }}
        canManage={canManage}
      />

      <SitesManager canManage={canManage} />
    </div>
  );
};

export default SettingsOrganisation;
