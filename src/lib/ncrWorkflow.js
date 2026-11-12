/** Labels for NC containment and disposition (the keys are the API's). */
export const CONTAINMENT_KINDS = [
  { value: "quarantine", label: "Quarantine" },
  { value: "sort", label: "Sort / inspect" },
  { value: "stop_ship", label: "Stop shipping" },
  { value: "notify_customer", label: "Notify customer" },
  { value: "notify_supplier", label: "Notify supplier" },
  { value: "recall", label: "Recall" },
  { value: "other", label: "Other" },
];
export const containmentKindLabel = (v) => CONTAINMENT_KINDS.find((k) => k.value === v)?.label ?? v;

export const DISPOSITION_DECISIONS = [
  { value: "rework", label: "Rework" },
  { value: "repair", label: "Repair" },
  { value: "scrap", label: "Scrap" },
  { value: "use_as_is", label: "Use as is" },
  { value: "return_to_supplier", label: "Return to supplier" },
  { value: "concession", label: "Concession" },
];
/** Made only by generating an RMA number on a customer non-conformance, so it is never offered in the decision list. */
export const RMA_DECISION = "customer_return";
export const decisionLabel = (v) => (v === RMA_DECISION ? "Customer return (RMA)" : (DISPOSITION_DECISIONS.find((d) => d.value === v)?.label ?? v));

/** The gates key for a stage key (the API uses camelCase). */
export const gateKey = (stage) => (stage === "awaiting_closure" ? "awaitingClosure" : stage);
