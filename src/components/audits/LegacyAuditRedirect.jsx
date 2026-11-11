import { Navigate, useLocation } from "react-router-dom";
import { legacyAuditPath } from "../../lib/audits";

/** The audit pages moved from /Documentation to /Audits: an old link goes to the new address, with its query and hash. */
const LegacyAuditRedirect = () => {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={`${legacyAuditPath(pathname) ?? "/Audits"}${search}${hash}`} replace />;
};

export default LegacyAuditRedirect;
