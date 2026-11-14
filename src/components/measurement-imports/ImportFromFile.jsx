import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import CTAButton from "@/components/CTAButton";
import { UploadIcon } from "@/components/icons";
import { uploadFileToSupabase } from "../../api/supabaseApi";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { useGauges } from "../../hooks/useCalibration";
import { useImportMutation, useInspectionImports, useMeasurementProfiles } from "../../hooks/useMeasurementImports";
import { describeApiError } from "../../lib/api-client";
import { IMPORT_STATUS, importPath, recallChoice, rememberChoice } from "../../lib/measurementImports";
import { formatDateTime } from "../../lib/processControl";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import { FileIcon } from "../ui/FileDrop";
import MenuCard from "../ui/MenuCard";

const ACCEPT = ".csv,.txt,.xlsx,.qif,.xml";
/** A QIF file (CM5) names its own checks, limits and units, so it needs no profile. */
export const isQifName = (name) => /\.(qif|xml)$/i.test(name ?? "");
const MAX_BYTES = 26_214_400;

const TONE = { warning: "bg-warning-color/15 text-warning-color", success: "bg-success-color/15 text-success-color", neutral: "bg-border-color text-secondary-text" };

export const ImportStatusPill = ({ status }) => {
  const s = IMPORT_STATUS[status] ?? IMPORT_STATUS.previewed;
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONE[s.tone]}`}>{s.label}</span>;
};

/**
 * Upload a CMM (or other gauge software) report onto a running inspection: the file goes to private storage, the server reads it with the chosen profile
 * and keeps it as a preview, which opens next. Nothing is recorded until the preview is applied. The profile and gauge are remembered per machine on this browser.
 */
export const ImportFileDialog = ({ inspection, back, onClose }) => {
  const { organisationId } = useOrganisation();
  const navigate = useNavigate();
  const profiles = useMeasurementProfiles();
  const gauges = useGauges({ pageSize: 200, sort: "assetNumber" });
  const mutation = useImportMutation();
  const remembered = useMemo(() => recallChoice(inspection.machine?.id), [inspection.machine?.id]);
  const list = profiles.data?.data ?? [];
  const [profileId, setProfileId] = useState(remembered.profileId ?? null);
  const [gaugeId, setGaugeId] = useState(remembered.gaugeId ?? null);
  const [file, setFile] = useState(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const input = useRef(null);
  const profile = list.find((p) => p.id === profileId) ?? (list.length === 1 ? list[0] : null);
  const qif = isQifName(file?.name);
  const chosenProfile = qif ? null : (profile?.id ?? null);
  // QIF files and PC-DMIS generic exports are read without a profile; for anything else the server asks for one.
  const ready = Boolean(file);

  const pick = (files) => {
    const f = files?.[0];
    if (!f) return;
    setError(f.size > MAX_BYTES ? "A measurement file can be at most 25 MB" : null);
    setFile(f.size > MAX_BYTES ? null : f);
  };

  const send = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const { path } = await uploadFileToSupabase(file, "inspection-files", organisationId, inspection.id, "inspection");
      const created = await mutation.mutateAsync({ action: "create", inspectionId: inspection.id, body: { path, fileName: file.name, profileId: chosenProfile ?? undefined, gaugeId: gaugeId ?? undefined } });
      rememberChoice(inspection.machine?.id, qif ? { profileId: remembered.profileId ?? null, gaugeId } : { profileId: chosenProfile, gaugeId });
      onClose();
      navigate(importPath(inspection.id, created.id, back));
    } catch (e) {
      setError(describeApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Import from a measurement file" onClose={onClose} width="max-w-xl">
      <div className="flex flex-col gap-4">
        {qif ? (
          <Callout tone="info" title="QIF file">
            A QIF file names its own checks, limits and units, so no profile is needed.
          </Callout>
        ) : profiles.isSuccess && list.length === 0 ? (
          <Callout tone="warning" title="No file profile yet">
            QIF files and PC-DMIS generic exports can be read now. For other table exports, someone who manages control plans sets up how your CMM&apos;s files are read, in Settings → Data Management → Process control → Measurement files.
          </Callout>
        ) : (
          <ComboField
            label="How the file is read"
            value={chosenProfile}
            placeholder="Work it out from the file"
            clearable
            onChange={setProfileId}
            options={list.map((p) => ({ value: p.id, label: p.name, hint: p.description ?? undefined }))}
            hint="The profile for this machine's software. Not needed for QIF files or PC-DMIS generic exports."
          />
        )}
        <ComboField
          label="Gauge used"
          value={gaugeId ?? (qif ? null : profile?.defaultGauge?.id) ?? null}
          onChange={setGaugeId}
          options={(gauges.data?.data ?? []).map((g) => ({ value: g.id, label: g.assetNumber, hint: g.description }))}
          hint={!qif && profile?.defaultGauge ? `The profile's own is ${profile.defaultGauge.assetNumber}.` : "Its calibration state is copied onto every reading."}
        />
        <div
          role="button"
          tabIndex={0}
          aria-label="Choose a measurement file"
          onClick={() => !busy && input.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !busy && input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); if (!busy) pick(e.dataTransfer.files); }}
          className={`flex cursor-pointer flex-col items-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm ${drag ? "border-theme bg-theme/5" : "border-border-color"} ${busy ? "opacity-60" : ""}`}>
          {file ? (
            <span className="flex items-center gap-2 font-medium text-primary-text"><FileIcon name={file.name} className="h-6 w-6" /> {file.name}</span>
          ) : (
            <span className="font-medium text-primary-text">Drop the report here or click to choose it</span>
          )}
          <span className="text-xs text-secondary-text">.csv, .txt, .xlsx, a PC-DMIS generic export or QIF (.qif, .xml), up to 25 MB. Nothing is recorded until you have checked the preview.</span>
          <input ref={input} type="file" accept={ACCEPT} className="hidden" data-testid="measurement-file" onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
        </div>
        {error && <Callout tone="error" role="alert">{error}</Callout>}
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton type="main" size="md" onClick={send} disabled={!ready} loading={busy} loadingText="Reading the file…" icon={UploadIcon}>
            Read the file
          </CTAButton>
        </div>
      </div>
    </Dialog>
  );
};

/** The Measurement files card on an inspection or a job: files read for it, with the way into each preview, and the import button for people who record. */
export const MeasurementFilesCard = ({ inspection, canRecord, back }) => {
  const imports = useInspectionImports(inspection.id);
  const [open, setOpen] = useState(false);
  const running = inspection.status === "in_progress";
  const list = imports.data?.data ?? [];
  if (!running && list.length === 0) return null;
  return (
    <MenuCard
      title="Measurement files"
      subtitle="Reports from a CMM or other gauge software, read into this inspection after you check them."
      action={running && canRecord ? <CTAButton type="secondary" icon={UploadIcon} onClick={() => setOpen(true)}>Import from CMM</CTAButton> : null}>
      {imports.error ? (
        <Callout tone="error">{describeApiError(imports.error)}</Callout>
      ) : list.length === 0 ? (
        <p className="text-sm text-secondary-text">No files yet.</p>
      ) : (
        <ul aria-label="Measurement files" className="flex flex-col divide-y divide-border-color">
          {list.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-3 py-2">
              <FileIcon name={i.fileName} className="h-8 w-8" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Link to={importPath(inspection.id, i.id, back)} className="truncate text-sm font-medium text-link-color hover:underline">
                  {i.reference} · {i.fileName}
                </Link>
                <span className="text-xs text-secondary-text">
                  {i.counts.parts} part{i.counts.parts === 1 ? "" : "s"} · {i.counts.toRecord} of {i.counts.features} features to record
                  {i.counts.failures ? ` · ${i.counts.failures} out of tolerance` : ""} · {formatDateTime(i.createdAt)}
                  {i.createdBy ? ` · ${i.createdBy}` : ""}
                </span>
              </div>
              <ImportStatusPill status={i.status} />
            </li>
          ))}
        </ul>
      )}
      {open && <ImportFileDialog inspection={inspection} back={back} onClose={() => setOpen(false)} />}
    </MenuCard>
  );
};
