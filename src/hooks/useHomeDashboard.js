import { useQuery } from "@tanstack/react-query";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { apiFetch } from "../lib/api-client";
import { homeModules, summarise } from "../lib/homeDashboard";
import { useMyCapaActions } from "./useCapa";
import { useMyDocumentCount } from "./useDocuments";
import { useMyAlertCount } from "./useDocumentation";
import { usePermissions } from "./useQmsApi";

/** What needs attention as of today in every area the person may read (`GET /home-dashboard`: one small request; areas they may not read are null). */
export const useHomeAttention = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: ["api", "org", organisationId, "home-dashboard"],
    queryFn: () => apiFetch("/home-dashboard", { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
};

/**
 * Everything the home page reports: a card per area with what needs attention there, the totals, and the person's own to-dos.
 * The areas come from one request; the to-dos are the counts the side menu's badges already keep, so they cost nothing more.
 */
export const useHomeDashboard = () => {
  const { can, isLoading: permissionsLoading } = usePermissions();
  const may = (permission) => !permissionsLoading && can(permission);
  const attention = useHomeAttention();

  const myAlerts = useMyAlertCount({ enabled: may("documentation.read") });
  const myDocuments = useMyDocumentCount({ enabled: may("documentation.read") });
  const myActions = useMyCapaActions("open", { enabled: may("capa.read") });

  const modules = homeModules(attention.data);
  const personal = [
    may("documentation.read") && {
      key: "alerts",
      label: "Quality alerts to acknowledge",
      count: myAlerts.data?.unacknowledged,
      overdue: myAlerts.data?.overdue ?? 0,
      to: "/Documentation/My-Alerts",
    },
    may("documentation.read") && {
      key: "documents",
      label: "Documents to read",
      count: myDocuments.data?.toRead,
      overdue: myDocuments.data?.overdue ?? 0,
      to: "/Documentation/My-Documents",
    },
    may("documentation.read") && {
      key: "reviews",
      label: "Documents waiting for your sign-off",
      count: myDocuments.data?.reviews,
      overdue: 0,
      to: "/Documentation/My-Documents",
    },
    may("capa.read") && {
      key: "actions",
      label: "8D actions assigned to you",
      count: myActions.data?.openCount,
      overdue: 0,
      to: "/CAPA/My-Actions",
    },
  ].filter(Boolean);

  return { modules, summary: summarise(modules), personal, isLoading: attention.isLoading, error: attention.error };
};
