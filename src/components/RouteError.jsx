import { useEffect, useState } from "react";
import { isRouteErrorResponse, useRouteError } from "react-router-dom";
import { TriangleAlertIcon } from "@/components/icons";
import CTAButton from "./CTAButton";
import NotFound from "./NotFound";
import { isChunkLoadError, reloadPage, shouldReloadForChunkError } from "../lib/chunkErrors";

/**
 * What the router shows when a page fails. An address that matches no page is the "Page not found" screen. A page file that could not be
 * loaded (the app was updated while this tab was open) reloads the tab once to pick up the new version. Anything else is a real error: it says
 * so, shows the message and offers a reload, instead of pretending the page does not exist.
 */
const RouteError = () => {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const stale = !notFound && isChunkLoadError(error);
  // "checking" is the moment before the effect decides; the reload itself is a side effect, so it never runs while rendering.
  const [phase, setPhase] = useState(stale ? "checking" : "error");
  const reloading = stale && phase !== "error";

  useEffect(() => {
    if (!stale) return;
    if (shouldReloadForChunkError()) {
      setPhase("reloading");
      reloadPage();
    } else {
      setPhase("error");
    }
  }, [stale]);

  if (notFound) return <NotFound />;

  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}`.trim() : (error?.message ?? String(error ?? ""));
  return (
    <div role="alert" className="flex min-h-screen w-full flex-col items-center justify-center gap-4 bg-primary-bg p-6 text-center">
      <TriangleAlertIcon className="text-4xl text-warning-color" />
      <h1 className="text-2xl font-semibold text-primary-text">{reloading ? "Updating…" : stale ? "A new version is available" : "Something went wrong"}</h1>
      <p className="max-w-md text-sm text-secondary-text">
        {reloading
          ? "Fortress QMS has been updated. Reloading to pick up the new version."
          : stale
            ? "Fortress QMS has been updated since this page was opened. Reload to continue."
            : "This page could not be shown. Reloading usually fixes it; if it does not, tell us what you were doing and send the message below."}
      </p>
      {!reloading && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <CTAButton type="main" size="md" text="Reload the page" onClick={reloadPage} />
          <CTAButton type="neutral" size="md" text="Go to the dashboard" to="/Dashboard" />
        </div>
      )}
      {!stale && message && (
        <p className="max-w-xl break-words rounded-lg border border-border-color bg-secondary-bg px-3 py-2 font-mono text-xs text-secondary-text">{message}</p>
      )}
    </div>
  );
};

export default RouteError;
