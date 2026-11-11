import { useState } from "react";
import { flushSync } from "react-dom";
import { FileDownIcon, PrinterIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useControlledCopy } from "../../hooks/useDocuments";
import { copyStamp, isPdfFile } from "../../lib/documents";
import Callout from "../ui/Callout";
import MenuCard from "../ui/MenuCard";
import DocumentEditor from "./DocumentEditor";

/** The print view of a written document: only this block prints, with the stamp at the top of the page. */
const PrintView = ({ revision, documentNumber, title }) => {
  const stamp = copyStamp(revision, documentNumber);
  return (
    <div id="document-print" className="hidden print:block">
      <style>
        {"@media print { body * { visibility: hidden !important; } #document-print, #document-print * { visibility: visible !important; } #document-print { display: block !important; position: absolute; left: 0; top: 0; width: 100%; margin: 0; padding: 0; } }"}
      </style>
      <div className={`mb-4 border-b pb-2 ${stamp.usable ? "border-blue-700" : "border-red-700"}`}>
        <p className={`text-sm font-bold ${stamp.usable ? "text-blue-800" : "text-red-700"}`}>{stamp.head}</p>
        <p className="text-xs text-gray-700">{stamp.detail}</p>
      </div>
      <h1 className="mb-3 text-xl font-semibold text-black">
        {documentNumber} · {title}
      </h1>
      <DocumentEditor value={revision.body} editable={false} onChange={() => {}} />
    </div>
  );
};

/**
 * Copies (DC5): a PDF main file opens as a controlled copy stamped on every page by the server (who, when, and whether it is the revision in force);
 * any other file is uncontrolled once printed or saved; a written document prints with the same stamp.
 */
const CopiesCard = ({ revision }) => {
  const doc = revision.document;
  const copy = useControlledCopy();
  const { showToast } = useToast();
  const main = revision.files.find((f) => f.role === "main" && !f.deletedAt);
  const open = (file) => copy.mutate(file.id, { onError: (err) => showToast({ type: "error", title: "No copy", message: describeApiError(err) }) });
  const inForce = revision.status === "effective";
  const [printing, setPrinting] = useState(false);
  // The print view (with today's stamp) exists only while the browser prints, so the page never shows the text twice.
  const print = () => {
    flushSync(() => setPrinting(true));
    try {
      window.print();
    } finally {
      setPrinting(false);
    }
  };

  if (doc.contentKind === "text") {
    if (!revision.body) return null;
    return (
      <MenuCard title="Print" subtitle={inForce ? "Printed copies say which revision they are, when they were printed, and to check it is still current." : "A printed copy of this revision says it is not for use."}>
        <div className="flex flex-col gap-3">
          <CTAButton type="secondary" icon={PrinterIcon} className="self-start" onClick={print}>
            Print or save as PDF
          </CTAButton>
          {printing && <PrintView revision={revision} documentNumber={doc.number} title={doc.title} />}
        </div>
      </MenuCard>
    );
  }
  if (!main) return null;
  return (
    <MenuCard title="Copies" subtitle="Work from the system where you can. A printed copy is only controlled for the day it was printed.">
      <div className="flex flex-col gap-3">
        {isPdfFile(main) ? (
          <>
            <p className="text-sm text-secondary-text">
              {inForce
                ? "Opens the PDF stamped on every page: controlled copy, the revision, when it took effect, and who printed it when."
                : "Opens the PDF stamped on every page as not for use."}
            </p>
            <CTAButton type="secondary" icon={FileDownIcon} className="self-start" loading={copy.isPending} onClick={() => open(main)}>
              {inForce ? "Open a controlled copy" : "Open a copy marked not for use"}
            </CTAButton>
          </>
        ) : (
          <Callout tone="warning" title="Uncontrolled when printed or saved">
            {main.fileName} is not a PDF, so it cannot be stamped. Anyone who prints or saves it must check it is still the revision in force before using it. Upload a PDF as the
            main file (and this file as an attachment) to give controlled copies.
          </Callout>
        )}
      </div>
    </MenuCard>
  );
};

export default CopiesCard;
