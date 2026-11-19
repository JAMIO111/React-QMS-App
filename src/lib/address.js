/** The address fields a customer or supplier shares. A form keeps these keys in its state and sends them (empty ones as null). */
export const EMPTY_ADDRESS = { addressLine1: "", addressLine2: "", addressLine3: "", city: "", region: "", postcode: "", country: null, currency: null };

/** The address and currency as the API wants them: trimmed text or null, country and currency codes or null. */
export const addressBody = (form) => {
  const text = (v) => (typeof v === "string" ? v.trim() || null : null);
  return {
    addressLine1: text(form.addressLine1),
    addressLine2: text(form.addressLine2),
    addressLine3: text(form.addressLine3),
    city: text(form.city),
    region: text(form.region),
    postcode: text(form.postcode),
    country: form.country || null,
    currency: form.currency || null,
  };
};


/** The company's own general line: email, phone and web site. Not a person: people are the contacts, as many as needed with one primary. */
export const EMPTY_COMPANY_CONTACT = { email: "", phone: "", website: "" };

export const companyContactBody = (form) => {
  const text = (v) => (typeof v === "string" ? v.trim() || null : null);
  return { email: text(form.email), phone: text(form.phone), website: text(form.website) };
};
