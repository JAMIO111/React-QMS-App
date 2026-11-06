import { AttachmentDrop } from "../ui/FileDrop";
import { useCapaAttachmentMutation, useCapaAttachments } from "../../hooks/useCapa";

/** Evidence files on an 8D (private capa-files bucket). Running 8Ds can be added to and removed from; a closed one only lists and downloads. */
const CapaFiles = ({ capaId, canEdit }) => {
  const attachments = useCapaAttachments(capaId);
  const mutation = useCapaAttachmentMutation();
  return (
    <AttachmentDrop
      recordId={capaId}
      bucket="capa-files"
      folder="capa"
      attachments={attachments}
      mutation={mutation}
      attachUrl={`/capas/${capaId}/attachments`}
      itemBase="/capa-attachments"
      title="Evidence files"
      subtitle={canEdit ? "Photos, reports, audit sheets and anything else that shows the work was done." : undefined}
      canEdit={canEdit}
    />
  );
};

export default CapaFiles;
