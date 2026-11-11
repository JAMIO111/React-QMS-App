import { useDocuments } from "../../hooks/useDocuments";
import { useDebouncedSearch } from "../../hooks/useDebouncedSearch";
import { RemoteComboBox } from "../ncr/Pickers";

const STATUS_HINT = { draft: "not in force yet", withdrawn: "withdrawn" };
const option = (d) => ({ id: d.id, name: `${d.number} · ${d.title}`, hint: STATUS_HINT[d.status] });

/**
 * Chooses the controlled document that is a gauge type's calibration procedure (search by number, title or text; documents that are
 * drafts or in force). `current` is the saved document ({ id, number, title, status }), so it shows before any search.
 */
const ProcedureDocumentPicker = ({ current, label = "Procedure", ...props }) => {
  const [q, setSearch] = useDebouncedSearch();
  const documents = useDocuments({ q, status: "draft,active", pageSize: 20 });
  return (
    <RemoteComboBox
      {...props}
      label={label}
      placeholder="Search a document…"
      items={(documents.data?.data ?? []).map(option)}
      isFetching={documents.isFetching}
      onSearch={setSearch}
      current={current ? option(current) : undefined}
      clearable
    />
  );
};

export default ProcedureDocumentPicker;
