/** The states a control plan register can be filtered by (any of those chosen); `key` is what the API's `status` takes. */
export const REVISION_STATE_OPTIONS = [
  { key: "effective", label: "Has an effective revision" },
  { key: "no_effective", label: "No effective revision" },
  { key: "pending_approval", label: "Awaiting approval" },
  { key: "draft", label: "Draft in progress" },
];
