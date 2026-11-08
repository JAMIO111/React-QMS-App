import { Navigate, useLocation, useParams } from "react-router-dom";
import { NCR_REGISTER, ncrPath } from "../../lib/ncr";

/** What the old register of each kind showed, as a source filter on the one register. */
const LEGACY = { Internal: "internal", Customer: "customer", Supplier: "supplier,goods_receiving" };

/**
 * The three registers (/Non-Conformance/Internal|Customer|Supplier[/:id]) became one: old bookmarks and links land on the
 * register filtered like the old one, or on the record itself. Anything else under /Non-Conformance goes to the register.
 */
const LegacyNcrRedirect = () => {
  const { type, id } = useParams();
  const { search } = useLocation();
  if (id) return <Navigate to={`${ncrPath(id)}${id === "new" && LEGACY[type] ? `?source=${LEGACY[type].split(",")[0]}` : search}`} replace />;
  const params = new URLSearchParams(search);
  if (LEGACY[type] && !params.has("source")) params.set("source", LEGACY[type]);
  const qs = params.toString();
  return <Navigate to={`${NCR_REGISTER}${qs ? `?${qs}` : ""}`} replace />;
};

export default LegacyNcrRedirect;
