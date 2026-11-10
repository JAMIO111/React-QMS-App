import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
let advanced;
const apiFetch = vi.fn();
const toast = vi.fn();
const updateOrg = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useOrganisationDetails: () => ({ data: { settings: { advancedImports: advanced } } }),
  useUpdateOrganisation: () => ({ mutate: updateOrg, isPending: false }),
}));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: toast }) }));

import { cleanSteps, defaultTemplate, describeStep, insertAt, newStep, stepProblem, suggestionsFor, templateChanged, templateSettings, tokenAt, versionChanges } from "../../lib/importTemplates";
import { mappingToRows, rowHasSource, rowsToFields } from "../../lib/integrations";
import TemplatesPage, { TemplatePage } from "./TemplatesPage";
import SettingsIntegrations from "../Settings/SettingsIntegrations";

const person = { id: "u1", name: "Ada Owner" };
const tpl = (over = {}) => ({ id: "t1", entityType: "machine", name: "MES machines", description: "Weekly export", currentVersion: 2, archived: null, createdBy: person, createdAt: "2026-11-09T09:00:00Z", updatedAt: "2026-11-10T09:00:00Z", runCount: 3, lastUsedAt: "2026-11-10T10:00:00Z", ...over });
const v1 = { version: 1, keyField: "Ref", fields: [{ target: "code", source: "Ref" }, { target: "name", source: "Desc" }], sourceSettings: {}, expectedColumns: ["Ref", "Desc"], settings: { writeMode: "add_only", matchExisting: false }, reason: null, current: false, createdBy: person, createdAt: "2026-11-09T09:00:00Z", runCount: 1 };
const v2 = { ...v1, version: 2, fields: [{ target: "code", source: "Ref", steps: [{ kind: "upper" }] }, { target: "name", formula: "PROPER([Desc])" }], settings: { writeMode: "add_update", matchExisting: true }, reason: "Codes in capitals", current: true, runCount: 2 };
const catalogue = { data: [{ entityType: "machine", label: "Machines", keyHint: "Code", fields: [{ key: "code", label: "Code", type: "text", required: true }, { key: "name", label: "Name", type: "text", required: true }] }] };

const calls = [];
const routeApi = (routes) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    return typeof routes[k] === "function" ? routes[k](path, opts) : routes[k];
  });
const renderAt = (at) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/Settings/Integrations" element={<SettingsIntegrations />} />
          <Route path="/Settings/Integrations/Templates" element={<TemplatesPage />} />
          <Route path="/Settings/Integrations/Templates/:templateId" element={<TemplatePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["integrations.read", "integrations.manage", "integrations.run", "organisation.manage"];
  advanced = true;
  calls.length = 0;
  apiFetch.mockReset();
  toast.mockReset();
  updateOrg.mockReset();
});

describe("template helpers", () => {
  it("makes, describes and checks steps, and cleans them for the API", () => {
    expect(newStep("number")).toEqual({ kind: "number", decimal: ".", thousands: "" });
    expect(newStep("join")).toEqual({ kind: "join", parts: [{ current: true }] });
    expect(describeStep({ kind: "replace", find: "-", with: "/" })).toBe('Replace "-" with "/"');
    expect(describeStep({ kind: "convert", from: "in", to: "mm" })).toBe("Convert in → mm");
    expect(describeStep({ kind: "join", parts: [{ current: true }, { text: "-" }, { column: "Rev" }] })).toBe('Join value + "-" + [Rev]');
    expect(stepProblem({ kind: "replace" })).toBe("Replace: find is needed");
    expect(stepProblem({ kind: "divide", by: 0 })).toBe("Cannot divide by 0");
    expect(stepProblem({ kind: "date", format: "qq" })).toMatch(/yyyy, MM and dd/);
    expect(stepProblem({ kind: "if", test: "one_of", list: [] })).toBeNull();
    expect(cleanSteps([{ kind: "map", values: { a: "b" }, _valuesText: "a=b", unmatched: "keep" }, { kind: "round", places: "2" }, { kind: "if", test: "empty", value: "x", then: "n/a" }])).toEqual([
      { kind: "map", values: { a: "b" }, unmatched: "keep" },
      { kind: "round", places: 2 },
      { kind: "if", test: "empty", then: "n/a" },
    ]);
  });

  it("carries steps and formulas through the rows, and a formula counts as the source", () => {
    const fields = catalogue.data[0].fields;
    const rows = mappingToRows(fields, v2, ["Ref", "Desc"]);
    expect(rows[1]).toMatchObject({ useFormula: true, formula: "PROPER([Desc])" });
    expect(rowHasSource(rows[1])).toBe(true);
    expect(rowHasSource({ ...rows[1], formula: " " })).toBe(false);
    expect(rowHasSource({ ...rows[0], source: null, steps: [{ kind: "default", text: "X" }] })).toBe(true);
    expect(rowsToFields(rows, fields)).toEqual(v2.fields);
  });

  it("knows when a mapping differs from a template version, and which template a kind starts from", () => {
    expect(templateChanged(v2, { keyField: "Ref", fields: [...v2.fields].reverse(), settings: v2.settings })).toBe(false);
    expect(templateChanged(v2, { keyField: "Ref", fields: v2.fields, settings: { writeMode: "add_only", matchExisting: true } })).toBe(true);
    expect(templateChanged(null, { keyField: "Ref", fields: [], settings: {} })).toBe(true);
    expect(templateSettings("nonconformance", { writeMode: "add_update", matchExisting: true })).toEqual({ writeMode: "add_only", matchExisting: false });
    expect(defaultTemplate([tpl({ id: "a", lastUsedAt: "2026-11-01T00:00:00Z" }), tpl({ id: "b" }), tpl({ id: "c", archived: { reason: "x" }, lastUsedAt: "2026-12-01T00:00:00Z" })]).id).toBe("b");
    expect(defaultTemplate([tpl({ lastUsedAt: null })]).id).toBe("t1");
    expect(defaultTemplate([tpl({ id: "a", lastUsedAt: null }), tpl({ id: "b", lastUsedAt: null })])).toBeNull();
  });

  it("says what changed between versions", () => {
    expect(versionChanges(null, v1)).toEqual(["First version"]);
    expect(versionChanges(v1, v2, (k) => k.toUpperCase())).toEqual([
      "CODE: Ref → Ref → Capitals",
      "NAME: Desc → formula PROPER([Desc])",
      "Import settings: add_only → add_update, match existing",
    ]);
    expect(versionChanges(v2, v2)).toEqual(["No change"]);
  });

  it("suggests columns after [ and functions while typing a name", () => {
    expect(tokenAt("UPPER([Sta", 10)).toEqual({ kind: "column", text: "Sta", start: 6 });
    expect(tokenAt("CONCAT(UP", 9)).toEqual({ kind: "function", text: "UP", start: 7 });
    expect(tokenAt('"x" & ', 6)).toBeNull();
    expect(suggestionsFor({ kind: "column", text: "sta" }, ["Status", "Odd]x"], [])).toEqual([{ label: "Status", insert: "[Status]", hint: "column" }]);
    expect(suggestionsFor({ kind: "column", text: "odd" }, ["Odd]x"], [])[0].insert).toBe("[Odd]]x]");
    expect(suggestionsFor({ kind: "function", text: "up" }, [], [{ name: "UPPER", usage: "UPPER(text)", description: "In capitals" }])).toEqual([{ label: "UPPER(text)", insert: "UPPER(", hint: "In capitals" }]);
    expect(insertAt("AB", 1, "x")).toEqual({ formula: "AxB", cursor: 2 });
  });
});

describe("template manager", () => {
  const routes = (over = {}) => ({
    "GET /integrations/entities": catalogue,
    "GET /integrations/templates": (path) => ({ data: path.includes("archived=only") ? [tpl({ id: "t9", name: "Old machines", archived: { at: "2026-11-10T08:00:00Z", by: person, reason: "Replaced" } })] : [tpl()] }),
    "GET /integrations/templates/t1": { ...tpl(), canManage: true, current: v2 },
    "GET /integrations/templates/t1/versions": { data: [{ ...v2, fieldCount: 2 }, { ...v1, fieldCount: 2 }] },
    "GET /integrations/templates/t1/versions/1": v1,
    "GET /integrations/templates/t1/versions/2": v2,
    ...over,
  });

  it("lists templates by kind with their version and use; archived ones on their own tab", async () => {
    routeApi(routes());
    renderAt("/Settings/Integrations/Templates");
    const list = await screen.findByRole("list", { name: "Templates" });
    expect(within(list).getByRole("link", { name: "MES machines" })).toHaveAttribute("href", "/Settings/Integrations/Templates/t1");
    expect(within(list).getByText(/Machines · version 2 · 3 imports · last used/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(await screen.findByRole("link", { name: "Old machines" })).toBeInTheDocument();
    expect(calls.some((c) => c.path.includes("archived=only"))).toBe(true);
  });

  it("archives with a reason, and duplicates into a new template", async () => {
    routeApi(routes({ "POST /integrations/templates/t1/archive": { ...tpl(), archived: { reason: "Not used" } }, "POST /integrations/templates/t1/duplicate": { ...tpl({ id: "t2", name: "Copy of MES machines" }), current: v2, canManage: true }, "GET /integrations/templates/t2": { ...tpl({ id: "t2", name: "Copy of MES machines", currentVersion: 1 }), current: { ...v2, version: 1 }, canManage: true }, "GET /integrations/templates/t2/versions": { data: [] } }));
    renderAt("/Settings/Integrations/Templates");
    await screen.findByRole("link", { name: "MES machines" });
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Archive" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Why?"), "Not used");
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/templates/t1/archive").body).toEqual({ reason: "Not used" }));
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    const dup = await screen.findByRole("dialog");
    expect(within(dup).getByLabelText("Name of the copy")).toHaveValue("Copy of MES machines");
    await userEvent.click(within(dup).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/templates/t1/duplicate").body).toEqual({ name: "Copy of MES machines" }));
    expect(await screen.findByText(/Machines · version 1/)).toBeInTheDocument();
  });

  it("shows a template's current version and versions; a version shows what changed and can be brought back with a reason", async () => {
    routeApi(routes({ "POST /integrations/templates/t1/restore-version": { ...tpl({ currentVersion: 3 }), current: { ...v1, version: 3 }, canManage: true } }));
    renderAt("/Settings/Integrations/Templates/t1");
    expect(await screen.findByText(/Key column/)).toHaveTextContent("Ref");
    expect(screen.getByText("PROPER([Desc])")).toBeInTheDocument();
    const versions = screen.getByRole("list", { name: "Versions" });
    expect(within(versions).getByText("Codes in capitals")).toBeInTheDocument();
    expect(within(versions).getByText("First version")).toBeInTheDocument();
    await userEvent.click(within(versions).getByRole("button", { name: "Version 2" }));
    let dialog = await screen.findByRole("dialog");
    const changes = await within(dialog).findByRole("region", { name: "What changed" });
    expect(within(changes).getByText("Code: Ref → Ref → Capitals")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Bring this version back" })).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: /close/i }));
    await userEvent.click(within(versions).getByRole("button", { name: "Version 1" }));
    dialog = await screen.findByRole("dialog");
    await userEvent.click(await within(dialog).findByRole("button", { name: "Bring this version back" }));
    const ask = screen.getAllByRole("dialog").at(-1);
    await userEvent.type(within(ask).getByLabelText("Why?"), "Capitals were wrong");
    await userEvent.click(within(ask).getByRole("button", { name: "Bring back" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/templates/t1/restore-version").body).toEqual({ version: 1, reason: "Capitals were wrong" }));
  });

  it("offers no commands to people who may only look, and says when advanced imports are off", async () => {
    permissions = ["integrations.read"];
    routeApi(routes());
    const { unmount } = renderAt("/Settings/Integrations/Templates");
    await screen.findByRole("link", { name: "MES machines" });
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    unmount();
    advanced = false;
    renderAt("/Settings/Integrations/Templates");
    expect(screen.getByText("Advanced imports are switched off")).toBeInTheDocument();
  });
});

describe("advanced imports switch", () => {
  const home = { "GET /integrations/connections": { data: [] }, "GET /integrations/runs": { data: [], page: 1, pageSize: 8, total: 0 } };

  it("switches advanced imports for people who manage the organisation, and links to the templates when on", async () => {
    advanced = false;
    routeApi(home);
    const { unmount } = renderAt("/Settings/Integrations");
    const sw = await screen.findByRole("switch", { name: "Advanced imports" });
    expect(sw).not.toBeChecked();
    expect(screen.queryByRole("link", { name: "Manage templates" })).toBeNull();
    await userEvent.click(sw);
    expect(updateOrg).toHaveBeenCalledWith({ body: { settings: { advancedImports: true } }, reason: "Advanced imports: on" }, expect.any(Object));
    expect(sw).toBeChecked();
    unmount();
    advanced = true;
    renderAt("/Settings/Integrations");
    expect(await screen.findByRole("link", { name: "Manage templates" })).toHaveAttribute("href", "/Settings/Integrations/Templates");
  });

  it("is read-only without organisation.manage", async () => {
    permissions = ["integrations.read"];
    routeApi(home);
    renderAt("/Settings/Integrations");
    expect(await screen.findByRole("switch", { name: "Advanced imports" })).toBeDisabled();
  });
});
