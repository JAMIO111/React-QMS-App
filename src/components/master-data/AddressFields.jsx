import { CoinsIcon } from "@/components/icons";
import Field from "../ui/Field";
import RHFComboBox from "../ui/RHFComboBox";
import { CURRENCY_OPTIONS } from "../../lib/costs";
import { countryOptions } from "../../lib/onboarding";

const COUNTRIES = countryOptions();

/** Address lines 1–3, town or city, county / state, postcode, country and the currency they are traded with in. `set` takes an input event, `pick` a chosen value, `lock` (from `useImportLocks`) disables the fields a scheduled import owns. */
const AddressFields = ({ form, set, pick, lock = () => ({}) }) => (
  <>
    <Field label="Address line 1" value={form.addressLine1} onChange={set("addressLine1")} {...lock("addressLine1")} maxLength={120} />
    <Field label="Address line 2" value={form.addressLine2} onChange={set("addressLine2")} {...lock("addressLine2")} maxLength={120} />
    <Field label="Address line 3" value={form.addressLine3} onChange={set("addressLine3")} {...lock("addressLine3")} maxLength={120} />
    <Field label="Town or city" value={form.city} onChange={set("city")} {...lock("city")} maxLength={80} />
    <Field label="County, state or region" value={form.region} onChange={set("region")} {...lock("region")} maxLength={80} />
    <Field label="Postcode" value={form.postcode} onChange={set("postcode")} {...lock("postcode")} maxLength={20} />
    <RHFComboBox label="Country" value={form.country} onChange={pick("country")} {...lock("country")} options={COUNTRIES} placeholder="Choose a country" clearable />
    <RHFComboBox
      label="Currency"
      icon={CoinsIcon}
      value={form.currency}
      onChange={pick("currency")}
      {...lock("currency")}
      options={CURRENCY_OPTIONS}
      placeholder="Choose a currency"
      hint="The currency you trade with them in"
      sort={false}
      clearable
    />
  </>
);

export default AddressFields;
