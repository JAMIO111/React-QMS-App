import RHFComboBox from "../ui/RHFComboBox";
import { useMe, useMembers, usePermissions } from "../../hooks/useQmsApi";

const fullName = (p) => [p?.firstName, p?.surname].filter(Boolean).join(" ") || p?.email || "Unnamed";

/**
 * A person in the organisation (custodian, technician). Lists active members for users who may
 * read the member directory; others can pick themselves (and keep the saved person).
 * `current` is the saved { id, name }.
 */
const PeoplePicker = ({ current, ...props }) => {
  const { can } = usePermissions();
  const me = useMe();
  const members = useMembers({ enabled: can("members.read") });
  const options = new Map();
  if (can("members.read")) {
    for (const m of members.data?.data ?? []) {
      if (m.userId && m.status === "active") options.set(m.userId, { id: m.userId, name: fullName(m), hint: m.jobTitle ?? undefined });
    }
  }
  const self = me.data?.profile;
  if (self && !options.has(self.id)) options.set(self.id, { id: self.id, name: fullName(self), hint: "You" });
  if (current?.id && !options.has(current.id)) options.set(current.id, { id: current.id, name: current.name });
  return <RHFComboBox {...props} options={[...options.values()]} />;
};

export default PeoplePicker;
