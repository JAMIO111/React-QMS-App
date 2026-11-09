import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "../contexts/ToastProvider";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { describeApiError } from "./api-client";
import { refreshOrganisation } from "./refresh";

/**
 * Save a form optimistically. The caller closes its dialog straight away; this puts the expected result into the screen's cached data (`patches`: `{ queryKey, update(previous) }`),
 * sends the request, and then
 *   - on success: toasts (when `success` is given) and marks the organisation's data stale so the server's version replaces the guess;
 *   - on failure: puts the previous data back and shows the server's message in a toast, so nothing is silently lost.
 * Nothing here throws: the dialog is already gone. Returns whether the save succeeded.
 */
export const useOptimisticSubmit = () => {
  const queryClient = useQueryClient();
  const { organisationId } = useOrganisation();
  const { showToast } = useToast();
  return useCallback(
    async ({ request, patches = [], success, errorTitle = "Not saved", me = false }) => {
      const snapshots = [];
      for (const { queryKey, update } of patches) {
        await queryClient.cancelQueries({ queryKey });
        const previous = queryClient.getQueryData(queryKey);
        if (previous !== undefined) {
          snapshots.push([queryKey, previous]);
          queryClient.setQueryData(queryKey, update(previous));
        }
      }
      try {
        await request();
        if (success) showToast({ type: "success", ...success });
        return true;
      } catch (error) {
        snapshots.forEach(([queryKey, data]) => queryClient.setQueryData(queryKey, data));
        showToast({ type: "error", title: errorTitle, message: describeApiError(error) });
        return false;
      } finally {
        refreshOrganisation(queryClient, organisationId, me ? { me: true } : undefined);
      }
    },
    [queryClient, organisationId, showToast],
  );
};
