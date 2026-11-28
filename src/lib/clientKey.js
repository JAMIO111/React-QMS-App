/**
 * A key a screen makes once when a form opens and sends with the create, so a double click or a resend answers the record already made instead of making another
 * (non-conformances, cost lines and dispositions; docs/audit-nc-2026-11.md API-13). A new key is made for each new form, never reused for a different record.
 */
export const newClientKey = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
