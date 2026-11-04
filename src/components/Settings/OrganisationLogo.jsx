import { useRef, useState } from "react";
import { CloudUploadIcon, Trash2Icon } from "@/components/icons";
import FortressMark from "../../assets/fortress-qms.svg";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import {
  LOGO_MAX_BYTES,
  LOGO_TYPES,
  removeOrganisationLogoFile,
  uploadOrganisationLogo,
  useOrganisationLogo,
  useUpdateOrganisation,
} from "../../hooks/useQmsApi";

/**
 * Settings → Organisation → Logo. Shown in the side menu for every member. Members with
 * organisation.manage upload (PNG, JPG, WebP or SVG, up to 1 MB), replace or remove it.
 */
const OrganisationLogo = ({ logoPath, canManage }) => {
  const { organisationId, organisation } = useOrganisation();
  const { data: logoUrl, isLoading } = useOrganisationLogo();
  const update = useUpdateOrganisation();
  const { showToast } = useToast();
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  const save = async (file) => {
    setProblem(null);
    if (!LOGO_TYPES[file.type]) return setProblem("Use a PNG, JPG, WebP or SVG image.");
    if (file.size > LOGO_MAX_BYTES) return setProblem("The logo must be 1 MB or smaller.");
    setBusy(true);
    try {
      const path = await uploadOrganisationLogo(file, organisationId);
      await update.mutateAsync({ body: { settings: { logoPath: path } } });
      await removeOrganisationLogoFile(logoPath);
      showToast({ type: "success", title: "Logo updated", message: "Everyone in the organisation will see the new logo." });
    } catch (err) {
      setProblem(err?.code ? describeApiError(err) : err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setProblem(null);
    setBusy(true);
    try {
      await update.mutateAsync({ body: { settings: { logoPath: null } } });
      await removeOrganisationLogoFile(logoPath);
      showToast({ type: "success", title: "Logo removed", message: "The Fortress QMS mark is shown instead." });
    } catch (err) {
      setProblem(describeApiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="org-logo-title" className="rounded-2xl border border-border-color bg-secondary-bg p-5 flex flex-col gap-3">
      <div>
        <h3 id="org-logo-title" className="text-primary-text font-semibold">
          Logo
        </h3>
        <p className="text-sm text-secondary-text">Shown at the top of the side menu for everyone in {organisation?.name ?? "the organisation"}.</p>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-2xl border border-border-color bg-white p-1">
          {isLoading && logoPath ? (
            <span className="text-xs text-secondary-text">Loading…</span>
          ) : (
            <img src={logoUrl || FortressMark} alt={logoUrl ? "Organisation logo" : "No logo yet (Fortress QMS mark)"} className="h-full w-full object-contain" />
          )}
        </div>
        {canManage ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
                className="flex items-center gap-2 rounded-lg border border-cta-btn-border bg-cta-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-cta-btn-bg-hover disabled:opacity-50 cursor-pointer">
                <CloudUploadIcon className="h-4 w-4" /> {busy ? "Saving…" : logoPath ? "Replace logo" : "Upload logo"}
              </button>
              {logoPath && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={remove}
                  className="flex items-center gap-2 rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-neutral-btn-bg-hover disabled:opacity-50 cursor-pointer">
                  <Trash2Icon className="h-4 w-4" /> Remove
                </button>
              )}
            </div>
            <p className="text-xs text-secondary-text">PNG, JPG, WebP or SVG, up to 1 MB. A square image works best.</p>
            <input
              ref={inputRef}
              type="file"
              data-testid="logo-input"
              accept={Object.keys(LOGO_TYPES).join(",")}
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) save(file);
              }}
            />
          </div>
        ) : (
          <p className="text-sm text-secondary-text">An administrator can change the logo.</p>
        )}
      </div>
      {problem && (
        <p role="alert" className="text-sm text-error-color">
          {problem}
        </p>
      )}
    </section>
  );
};

export default OrganisationLogo;
