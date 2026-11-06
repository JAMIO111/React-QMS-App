import { AttachmentDrop } from "../ui/FileDrop";
import { useAlertAttachmentMutation, useAlertAttachments } from "../../hooks/useDocumentation";

/**
 * Files on a quality alert (private quality-alert-files bucket). Drafts can be added to and removed from; once the alert is issued the files
 * are frozen and only listed and downloaded.
 */
const AlertFiles = ({ alertId, canEdit }) => {
  const attachments = useAlertAttachments(alertId);
  const mutation = useAlertAttachmentMutation();
  return (
    <AttachmentDrop
      recordId={alertId}
      bucket="quality-alert-files"
      folder="quality-alerts"
      attachments={attachments}
      mutation={mutation}
      attachUrl={`/quality-alerts/${alertId}/attachments`}
      itemBase="/quality-alert-attachments"
      title="Files"
      subtitle={canEdit ? "Photos, certificates and documents that help people understand the issue." : undefined}
      canEdit={canEdit}
    />
  );
};

export default AlertFiles;
