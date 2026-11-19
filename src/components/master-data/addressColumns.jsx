import { countryName } from "../../lib/onboarding";

const cell = (fn) => (i) => <span className="table-row-item">{fn(i.row.original) || "—"}</span>;
const column = (id, header, size, value) => ({ id, accessorFn: value, header, headerString: header, size, cell: cell(value) });

/** Address and currency columns for a customer or supplier list (the same keys as the API's rows). */
export const addressColumns = () => [
  column("addressLine1", "Address line 1", 200, (r) => r.addressLine1),
  column("addressLine2", "Address line 2", 180, (r) => r.addressLine2),
  column("addressLine3", "Address line 3", 180, (r) => r.addressLine3),
  column("city", "Town or city", 150, (r) => r.city),
  column("region", "County, state or region", 180, (r) => r.region),
  column("postcode", "Postcode", 110, (r) => r.postcode),
  column("country", "Country", 160, (r) => (r.country ? countryName(r.country) : null)),
];

/** The currency they are traded with in: shown by default. */
export const currencyColumn = () => column("currency", "Currency", 100, (r) => r.currency);

/** The company's general email, phone and web site (hidden at first, like the address). */
export const companyContactColumns = () => [
  column("email", "Company email", 220, (r) => r.email),
  column("phone", "Company phone", 150, (r) => r.phone),
  column("website", "Company website", 200, (r) => r.website),
];

/** Address columns start hidden (a person can show them from the column menu); the currency does not. */
export const ADDRESS_DEFAULT_HIDDEN = { email: false, phone: false, website: false, addressLine1: false, addressLine2: false, addressLine3: false, city: false, region: false, postcode: false, country: false };
