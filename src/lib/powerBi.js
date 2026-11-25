import { API_URL } from "./api-client";

/** The address reporting tools are pointed at (it answers a list of the datasets, so a connection test with a valid key succeeds). */
export const reportingBaseUrl = (apiUrl = API_URL) => `${String(apiUrl).replace(/\/$/, "")}/api/v1/reporting/v1`;

export const KEY_LIFETIMES = [
  { value: "90", label: "90 days" },
  { value: "180", label: "180 days" },
  { value: "365", label: "1 year (recommended)" },
  { value: "730", label: "2 years" },
];

export const KEY_STATUS = {
  active: { label: "Active", tone: "success" },
  expired: { label: "Expired", tone: "warning" },
  revoked: { label: "Revoked", tone: "danger" },
};

const M_TYPES = { text: "type text", number: "type number", date: "type date", datetime: "type datetimezone", boolean: "type logical" };

/**
 * The Power Query (M) script that loads one dataset. It pages through the answer with `nextCursor` and turns each column into the right type.
 * The key is NOT in the script: Power BI asks for credentials the first time, and the person chooses Basic, any user name and the key as the password,
 * so a shared report file never carries it. The fixed host with a RelativePath is what lets the Power BI service refresh it on a schedule.
 */
export function powerQueryScript({ baseUrl = reportingBaseUrl(), dataset, columns = [] }) {
  const typed = columns.filter((c) => M_TYPES[c.type]);
  const types = typed.map((c) => `{"${c.name}", ${M_TYPES[c.type]}}`).join(", ");
  return [
    "let",
    `    BaseUrl = "${baseUrl}",`,
    `    Dataset = "${dataset}",`,
    "    PageSize = 5000,",
    "    GetPage = (after as nullable text) as record =>",
    "        let",
    '            Query = [limit = Text.From(PageSize)] & (if after = null then [] else [after = after]),',
    "            Response = Json.Document(Web.Contents(BaseUrl, [",
    "                RelativePath = Dataset,",
    "                Query = Query,",
    "                ManualStatusHandling = {400, 401, 403, 404, 429}",
    "            ])),",
    '            Checked = if Record.HasFields(Response, "error")',
    '                then error Error.Record("Fortress", Response[error][message])',
    "                else Response",
    "        in",
    "            Checked,",
    "    Pages = List.Generate(",
    "        () => [Page = GetPage(null)],",
    "        each [Page] <> null,",
    "        each [Page = if [Page][nextCursor] = null then null else GetPage([Page][nextCursor])],",
    "        each [Page][data]",
    "    ),",
    "    Rows = List.Combine(Pages),",
    "    Result = if List.IsEmpty(Rows) then #table({}, {}) else Table.FromRecords(Rows)" + (types ? "," : ""),
    ...(types ? [`    Typed = if List.IsEmpty(Rows) then Result else Table.TransformColumnTypes(Result, {${types}}, "en-US")`] : []),
    "in",
    `    ${types ? "Typed" : "Result"}`,
  ].join("\n");
}

/** What a key says about when it was last used. */
export const lastUsedWords = (key) => (key.lastUsedAt ? `Last used ${new Date(key.lastUsedAt).toLocaleString("en-GB")}${key.lastUsedAddress ? ` from ${key.lastUsedAddress}` : ""}` : "Not used yet");
