import ActionList from "../ActionList";
import ReasonCard from "../ReasonCard";

/** D7: stop it happening elsewhere (preventive actions, similar parts and processes) and write down what was learned. */
const D7Prevent = ({ capa, editable }) => (
  <div className="flex flex-col gap-4">
    <ActionList capa={capa} phase="preventive" editable={editable} withCause title="Preventive actions" addLabel="Add preventive action"
      emptyText="No preventive action yet. Check similar parts, machines and processes, and fix procedures, plans or training." />
    <ReasonCard key={`n${capa.updatedAt}`} capa={capa} editable={editable} field="d7NoPreventiveReason" value={capa.d7NoPreventiveReason} title="No preventive action needed?"
      subtitle="If nothing else is exposed, say why instead of adding an action" ariaLabel="No preventive action" label="Why no preventive action is needed" saveLabel="Save reason" />
    <ReasonCard key={`l${capa.updatedAt}`} capa={capa} editable={editable} field="d7LessonsLearned" value={capa.d7LessonsLearned} title="Lessons learned"
      subtitle="What the organisation should remember from this 8D" ariaLabel="Lessons learned" label="What was learned" rows={4} saveLabel="Save lessons" />
  </div>
);

export default D7Prevent;
