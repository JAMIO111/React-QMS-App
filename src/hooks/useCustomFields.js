import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { orgRoot, refreshOrganisation } from "../lib/refresh";
import { CUSTOM_FIELD_LIMIT } from "../lib/customFields";

const fieldsKey = (organisationId, entityType, includeRetired) => ["api", "org", organisationId, "custom-fields", entityType ?? "all", includeRetired ? "all" : "active"];

/**
 * The organisation's custom fields: { data: definitions in display order, limit, entities: [{ entityType, label, stages, activeCount }] }.
 * Every member may read them. `entityType` narrows to one kind of record; `includeRetired` adds retired fields.
 */
export const useCustomFields = (entityType, { includeRetired = false, enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  const params = new URLSearchParams();
  if (entityType) params.set("entityType", entityType);
  if (includeRetired) params.set("includeRetired", "true");
  return useQuery({
    queryKey: fieldsKey(organisationId, entityType, includeRetired),
    queryFn: () => apiFetch(`/custom-fields${params.size ? `?${params}` : ""}`, { organisationId }),
    enabled: !!organisationId && enabled,
    staleTime: 1000 * 60 * 5,
    placeholderData: (previous) => previous,
  });
};

/** Active fields of a kind of record (an empty list while loading). */
export const useActiveCustomFields = (entityType, options) => {
  const query = useCustomFields(entityType, options);
  return { ...query, fields: query.data?.data?.filter((f) => f.active) ?? [], stages: query.data?.entities?.find((e) => e.entityType === entityType)?.stages ?? [] };
};

/**
 * Change the organisation's custom fields (custom_fields.manage):
 * `{ action: "create", body }`, `{ action: "update", id, body }`, `{ action: "retire", id, reason }`, `{ action: "reactivate", id }`,
 * `{ action: "reorder", entityType, ids }`. A reorder moves the list on screen at once and is put back if it fails.
 */
export const useCustomFieldMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body, reason, entityType, ids }) => {
      if (action === "create") return apiFetch("/custom-fields", { method: "POST", body, organisationId });
      if (action === "update") return apiFetch(`/custom-fields/${id}`, { method: "PATCH", body, organisationId });
      if (action === "retire") return apiFetch(`/custom-fields/${id}/retire`, { method: "POST", body: { reason }, organisationId });
      if (action === "reactivate") return apiFetch(`/custom-fields/${id}/reactivate`, { method: "POST", body: {}, organisationId });
      return apiFetch("/custom-fields/order", { method: "PUT", body: { entityType, ids }, organisationId });
    },
    onMutate: async ({ action, entityType, ids }) => {
      if (action !== "reorder") return {};
      const prefix = ["api", "org", organisationId, "custom-fields", entityType];
      await queryClient.cancelQueries({ queryKey: prefix });
      const previous = queryClient.getQueriesData({ queryKey: prefix });
      const rank = new Map(ids.map((id, i) => [id, i + 1]));
      queryClient.setQueriesData({ queryKey: prefix }, (old) =>
        old?.data ? { ...old, data: [...old.data].map((f) => ({ ...f, position: rank.get(f.id) ?? f.position })).sort((a, b) => a.position - b.position) } : old,
      );
      return { previous };
    },
    onError: (_e, _v, context) => context?.previous?.forEach(([k, v]) => queryClient.setQueryData(k, v)),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** Puts `values` into the `customValues` of every cached object with this id (lists, pages, details). */
const patchValues = (node, id, values) => {
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((item) => {
      const patched = patchValues(item, id, values);
      if (patched !== item) changed = true;
      return patched;
    });
    return changed ? next : node;
  }
  if (!node || typeof node !== "object") return node;
  let changed = false;
  const next = {};
  for (const [k, v] of Object.entries(node)) {
    const patched = k === "customValues" ? v : patchValues(v, id, values);
    if (patched !== v) changed = true;
    next[k] = patched;
  }
  if (node.id === id && "customValues" in node) {
    next.customValues = values;
    changed = true;
  }
  return changed ? next : node;
};

/** Merge `changes` into stored values the way the database does: null, "" or [] clears a key. */
export const mergeCustomValues = (current = {}, changes = {}) => {
  const out = { ...current };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) delete out[k];
    else out[k] = v;
  }
  return out;
};

/**
 * Fill in a record's custom values: `mutate({ values })` merges them (null / "" / [] clears one). The record shows the new values at once wherever
 * it is on screen (its page, register rows) and goes back if the database refuses (bad value, closed record, clearing a required one).
 */
export const useSetCustomValues = (entityType, recordId) => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ values }) => apiFetch(`/custom-values/${recordId}`, { method: "PUT", body: { entityType, values }, organisationId }),
    onMutate: async ({ values, current }) => {
      const root = orgRoot(organisationId);
      await queryClient.cancelQueries({ queryKey: root });
      const previous = queryClient.getQueriesData({ queryKey: root });
      const merged = mergeCustomValues(current ?? {}, values);
      queryClient.setQueriesData({ queryKey: root }, (old) => patchValues(old, recordId, merged));
      return { previous };
    },
    onError: (_e, _v, context) => context?.previous?.forEach(([k, v]) => queryClient.setQueryData(k, v)),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

export { CUSTOM_FIELD_LIMIT };

/** Members a person field can name: [{ id, name }] (every member may read them). */
export const useCustomFieldPeople = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: ["api", "org", organisationId, "custom-fields", "people"],
    queryFn: () => apiFetch("/custom-fields/people", { organisationId }).then((r) => r.data),
    enabled: !!organisationId && enabled,
    staleTime: 1000 * 60 * 10,
  });
};
