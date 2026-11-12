import { useState } from "react";
import { useParams } from "react-router-dom";
import { ArchiveIcon, PencilIcon, RotateCcwIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useRisk, useRiskModel, useRiskMutation } from "../../hooks/useRisk";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { BAND_LABEL, BAND_PILL, formatDay, isAcceptable, kindLabel, statusLabel, statusPill } from "../../lib/risk";
import { ErrorNotice } from "../master-data/shared";
import Callout from "../ui/Callout";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import { AssessDialog, RetireDialog, RiskDialog } from "./RiskDialogs";
import RiskMatrix from "./RiskMatrix";

const Fact = ({ label, children }) => (
  <div>
    <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">{label}</dt>
    <dd className="whitespace-pre-wrap text-sm text-primary-text">{children}</dd>
  </div>
);

/** A risk or an opportunity (`/Risk/Register/:id`): what it is, where it sits on the matrix before treatment, and every assessment it has had. */
const RiskPage = () => {
  const { id } = useParams();
  const query = useRisk(id);
  const model = useRiskModel();
  const mutation = useRiskMutation();
  const { showToast } = useToast();
  const [dialog, setDialog] = useState(null);
  const risk = query.data;
  useBreadcrumbNames([
    { path: `/Risk/Register/${id}`, label: risk ? `${risk.reference} · ${risk.title}` : null },
    { path: "/Risk", label: "Risk", to: "/Risk/Register" },
  ]);

  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <ErrorNotice error={query.error} />;
  const a = risk.inherent;
  const config = model.data?.config;
  const opportunity = risk.kind === "opportunity";
  const bringBack = () =>
    mutation.mutate({ action: "reactivate", id: risk.id }, { onError: (err) => showToast({ type: "error", title: "Not brought back", message: describeApiError(err) }) });

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-primary-text">{risk.reference}</h1>
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusPill(risk.status)}`}>{statusLabel(risk.status)}</span>
            <span className="inline-flex rounded-full bg-secondary-bg px-2 py-0.5 text-xs font-medium text-secondary-text">{kindLabel(risk.kind)}</span>
          </div>
          <p className="text-lg text-primary-text">{risk.title}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {risk.canEdit && (
            <CTAButton type="main" onClick={() => setDialog("assess")}>
              {a ? "Assess again" : "Assess it"}
            </CTAButton>
          )}
          {risk.canEdit && (
            <CTAButton type="secondary" icon={PencilIcon} onClick={() => setDialog("edit")}>
              Edit details
            </CTAButton>
          )}
          {risk.canManage && risk.status !== "retired" && (
            <CTAButton type="danger" icon={ArchiveIcon} onClick={() => setDialog("retire")}>
              Retire
            </CTAButton>
          )}
          {risk.canManage && risk.status === "retired" && (
            <CTAButton type="secondary" icon={RotateCcwIcon} loading={mutation.isPending} onClick={bringBack}>
              Bring back
            </CTAButton>
          )}
        </div>
      </header>

      {risk.status === "retired" && (
        <Callout tone="warning" title="Retired">
          {risk.retiredReason} ({formatDay(risk.retiredAt)}). It is kept with its assessments and can be brought back.
        </Callout>
      )}
      {risk.status === "draft" && (
        <Callout tone="info" title="Not assessed yet">
          {risk.canEdit ? "Assess it to put it in the register as open." : "It joins the register as open once it has been assessed."}
        </Callout>
      )}
      {a && config && !opportunity && risk.status !== "retired" && !isAcceptable(config, a.band) && (
        <Callout tone="warning" title={`${BAND_LABEL[a.band]} — above the level your organisation accepts`}>
          Risks above {BAND_LABEL[config.acceptanceBand].toLowerCase()} need treatment, or an approved acceptance.
        </Callout>
      )}

      <MenuCard title="Details">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Category">{risk.category.label}</Fact>
          <Fact label="Owner">{risk.owner?.name ?? "—"}</Fact>
          <Fact label="Where">{[risk.site?.name, risk.department?.name].filter(Boolean).join(" · ") || "The whole organisation"}</Fact>
          <Fact label="Raised">{formatDay(risk.createdAt)}</Fact>
          {risk.description && (
            <div className="sm:col-span-2 lg:col-span-4">
              <Fact label="Description">{risk.description}</Fact>
            </div>
          )}
          <div className="sm:col-span-1 lg:col-span-2">
            <Fact label={opportunity ? "What makes it possible" : "Cause"}>{risk.cause ?? "—"}</Fact>
          </div>
          <div className="sm:col-span-1 lg:col-span-2">
            <Fact label={opportunity ? "What would be gained" : "Effect"}>{risk.effect ?? "—"}</Fact>
          </div>
        </dl>
      </MenuCard>

      <MenuCard title="Before treatment" subtitle={opportunity ? "How likely it is and how much it would gain, as things stand." : "How likely it is and how bad it would be, as things stand."}>
        {a ? (
          <div className="flex flex-wrap items-start gap-6">
            {config && <RiskMatrix config={config} selected={a} compact ariaLabel="Where it sits on the matrix" />}
            <dl className="flex min-w-56 flex-1 flex-col gap-3">
              <Fact label="Score">
                <span className="text-2xl font-semibold">{a.score}</span>{" "}
                <span className={`ml-1 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${BAND_PILL[a.band]}`}>{BAND_LABEL[a.band]}</span>
              </Fact>
              <Fact label="Likelihood">
                {a.likelihood} · {risk.assessments.find((x) => x.current)?.likelihoodLabel}
              </Fact>
              <Fact label="Consequence">
                {a.consequence} · {risk.assessments.find((x) => x.current)?.consequenceLabel}
              </Fact>
              <Fact label="Why">{risk.assessments.find((x) => x.current)?.rationale}</Fact>
              <Fact label="Assessed">
                {formatDay(a.assessedOn)} by {risk.assessments.find((x) => x.current)?.assessedBy ?? "Unknown"} · matrix version {a.modelVersion}
                {model.data && a.modelVersion !== model.data.version ? ` (the matrix is now version ${model.data.version}: assess again to score it on that)` : ""}
              </Fact>
            </dl>
          </div>
        ) : (
          <p className="text-sm text-secondary-text">Not assessed yet.</p>
        )}
      </MenuCard>

      {risk.assessments.length > 1 && (
        <MenuCard title="Assessment history" subtitle="Every assessment is kept; a new one replaces the one before.">
          <ul className="-my-3 divide-y divide-border-color" aria-label="Assessment history">
            {risk.assessments.map((x) => (
              <li key={x.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm text-primary-text">
                    {x.likelihood} × {x.consequence} = {x.score} <span className="text-secondary-text">· {x.likelihoodLabel} × {x.consequenceLabel}</span>
                  </span>
                  <span className="whitespace-pre-wrap text-sm text-secondary-text">{x.rationale}</span>
                  <span className="text-xs text-secondary-text">
                    {formatDay(x.assessedOn)} · {x.assessedBy ?? "Unknown"} · matrix version {x.modelVersion}
                  </span>
                </div>
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${BAND_PILL[x.band]}`}>
                  {BAND_LABEL[x.band]}
                  {x.current ? " · current" : ""}
                </span>
              </li>
            ))}
          </ul>
        </MenuCard>
      )}

      {dialog === "edit" && <RiskDialog existing={risk} onClose={() => setDialog(null)} />}
      {dialog === "assess" && <AssessDialog risk={risk} onClose={() => setDialog(null)} />}
      {dialog === "retire" && <RetireDialog risk={risk} onClose={() => setDialog(null)} />}
    </div>
  );
};

export default RiskPage;
