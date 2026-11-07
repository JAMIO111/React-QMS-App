import { Navigate, useParams } from "react-router-dom";

/** Until the operator hub screen exists, a job opens on its inspection record. */
const JobRedirect = () => <Navigate to={`/Inspections/${useParams().id}`} replace />;

export default JobRedirect;
