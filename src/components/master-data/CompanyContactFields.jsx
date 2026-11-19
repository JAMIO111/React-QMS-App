import Field from "../ui/Field";

/**
 * The company's general email, phone and web site (a switchboard, info@, the site), for a customer or supplier. They are not a person's details:
 * named people, each with their own email and phone, go under Contacts, as many as needed.
 */
const CompanyContactFields = ({ form, set }) => (
  <>
    <Field label="Company email" value={form.email} onChange={set("email")} maxLength={200} hint="The general address, such as info@. People go under Contacts" />
    <Field label="Company phone" value={form.phone} onChange={set("phone")} maxLength={40} hint="The main number, not a person's" />
    <Field label="Company website" value={form.website} onChange={set("website")} maxLength={200} />
  </>
);

export default CompanyContactFields;
