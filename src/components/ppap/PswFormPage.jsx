import { Link, useParams } from "react-router-dom";
import { ArrowLeftIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { usePswForm } from "../../hooks/usePpap";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { formatDay, levelLabel, ppapPath, reasonLabel } from "../../lib/ppap";
import Callout from "../ui/Callout";

const Row = ({ label, children }) => (
  <tr className="border-b border-border-color align-top">
    <th scope="row" className="w-56 bg-secondary-bg px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-secondary-text">{label}</th>
    <td className="whitespace-pre-wrap px-3 py-2 text-sm text-primary-text">{children || "—"}</td>
  </tr>
);

const Section = ({ title, children }) => (
  <section className="flex flex-col gap-1">
    <h2 className="text-sm font-semibold text-primary-text">{title}</h2>
    <table className="w-full border border-border-color">
      <tbody>{children}</tbody>
    </table>
  </section>
);

/**
 * The Part Submission Warrant as a form (`/PPAP/:id/psw`): what the submission already holds beside the typed fields and the signature, ready to print or save as PDF from the
 * browser (only the form prints). Until the submission is sent it is a draft and says so; nothing is worked out here.
 */
const PswFormPage = () => {
  const { id } = useParams();
  const query = usePswForm(id);
  const form = query.data;
  useBreadcrumbNames([
    { path: `/PPAP/${id}`, label: form ? `${form.reference} · ${form.part.number ?? ""}` : null },
    { path: `/PPAP/${id}/psw`, label: "Warrant" },
  ]);
  if (query.isLoading) return <p className="p-4 text-sm text-secondary-text">Loading…</p>;
  if (query.isError) return <Callout tone="error" role="alert">Could not load this warrant.</Callout>;

  const signed = Boolean(form.signer);
  const draft = !form.frozen;
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3 overflow-y-auto p-4">
      <style>{"@media print { body * { visibility: hidden !important; } #psw-form, #psw-form * { visibility: visible !important; } #psw-form { position: absolute; left: 0; top: 0; width: 100%; margin: 0; padding: 0; box-shadow: none; } }"}</style>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to={ppapPath(id)} className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
          <ArrowLeftIcon className="h-4 w-4" /> Back to the submission
        </Link>
        <CTAButton buttonType="button" type="secondary" size="md" onClick={() => window.print()}>
          Print or save as PDF
        </CTAButton>
      </div>
      <article id="psw-form" aria-label="Part Submission Warrant" className="mx-auto flex w-full max-w-4xl flex-col gap-4 rounded-md border border-border-color bg-primary-bg p-6">
        <header className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold text-primary-text">Part Submission Warrant</h1>
            <p className="text-sm text-secondary-text">
              {form.reference} · {levelLabel(form.level)} · {reasonLabel(form.reason)}
            </p>
          </div>
          {draft && <p className="rounded border border-warning-color px-2 py-1 text-sm font-medium text-warning-color">Draft: not sent{signed ? "" : ", not signed"}</p>}
        </header>

        <Section title="The part">
          <Row label="Part number">{form.part.number}</Row>
          <Row label="Part name">{form.part.name}</Row>
          <Row label="Revision">{form.revision.label}</Row>
          <Row label="Drawing reference">{form.revision.drawingRef}</Row>
          <Row label="Released">{form.revision.releasedOn ? formatDay(form.revision.releasedOn) : null}</Row>
          <Row label="Engineering change level">{form.engineeringChangeLevel}</Row>
          <Row label="Part weight">{form.weight ? `${form.weight.value} ${form.weight.unit}` : null}</Row>
        </Section>

        <Section title="Submitted to">
          <Row label="Customer">{form.customer.name ? `${form.customer.name}${form.customer.code ? ` (${form.customer.code})` : ""}` : null}</Row>
          <Row label="Address">{form.customer.address}</Row>
          <Row label="Purchase order">{form.purchaseOrder}</Row>
        </Section>

        <Section title="Submitted by">
          <Row label="Organisation">{form.organisation}</Row>
          <Row label="Manufacturing site">{form.site}</Row>
          <Row label="Sent on">{form.sentOn ? formatDay(form.sentOn) : null}</Row>
        </Section>

        <Section title="Declaration">
          <Row label="Results meet all the requirements">{form.resultsMeetRequirements == null ? null : form.resultsMeetRequirements ? "Yes" : "No"}</Row>
          <Row label="Explanation">{form.declaration}</Row>
        </Section>

        <Section title="Signed">
          <Row label="Name">{form.signer?.name ?? "Not yet signed"}</Row>
          <Row label="Title">{form.signer?.title}</Row>
          <Row label="Phone">{form.signer?.phone}</Row>
          <Row label="Date">{form.signer?.signedOn ? formatDay(form.signer.signedOn) : null}</Row>
        </Section>
      </article>
    </div>
  );
};

export default PswFormPage;
