import { useCallback } from "react";
import { useToast } from "../contexts/ToastProvider";
import { describeApiError } from "../lib/api-client";

/**
 * Send an optimistic request and forget it: the screen has already changed (the hook's guess) and the caller may close its dialog straight away. If the
 * server refuses, the hook puts the data back and this shows why in an error toast. Uses `mutateAsync`, whose promise settles even when the dialog that
 * sent it is gone (a `mutate` callback would not run then). Resolves to the server's answer, or `undefined` when it failed.
 */
export const useQuickSave = (mutation, defaultTitle = "Not saved") => {
  // Outside a ToastProvider (some tests) a refusal is still put back, just not announced.
  const showToast = useToast()?.showToast;
  const { mutateAsync } = mutation;
  return useCallback(
    (request, errorTitle = defaultTitle) =>
      mutateAsync(request).catch((error) => {
        showToast?.({ type: "error", title: errorTitle, message: describeApiError(error) });
        return undefined;
      }),
    [mutateAsync, showToast, defaultTitle],
  );
};
