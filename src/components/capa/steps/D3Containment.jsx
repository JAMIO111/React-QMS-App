import ActionList from "../ActionList";
import ReasonCard from "../ReasonCard";

/** D3: actions that protect the customer now, and stay until a permanent fix is proven. */
const D3Containment = ({ capa, editable }) => (
  <div className="flex flex-col gap-4">
    <ActionList capa={capa} phase="interim" editable={editable} title="Containment actions" addLabel="Add containment action"
      emptyText="No containment action yet. Sort, quarantine or inspect what could reach the customer, and give each action an owner and a date." />
    <ReasonCard key={capa.updatedAt} capa={capa} editable={editable} field="d3NoContainmentReason" value={capa.d3NoContainmentReason} title="No containment needed?"
      subtitle="If nothing needs protecting, say why instead of adding an action" ariaLabel="No containment" label="Why no containment is needed"
      hint="e.g. no product has left the plant and none is in stock" saveLabel="Save reason" />
  </div>
);

export default D3Containment;
