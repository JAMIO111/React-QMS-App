import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { wizardPath } from "../../lib/integrations";

/** The old mapping page's address: mapping now happens in step 3 of the file import wizard. */
const MappingPage = () => {
  const { id } = useParams();
  const [params] = useSearchParams();
  const entity = params.get("entity");
  const file = params.get("file");
  return <Navigate replace to={wizardPath(id, { entity, file, step: entity && file ? 3 : entity ? 2 : 1 })} />;
};

export default MappingPage;
