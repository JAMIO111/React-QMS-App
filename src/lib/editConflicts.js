/**
 * Edit conflicts on screen (docs/edit-conflicts-plan.md EC3). A save that sends the version it was based on (`rowVersion` in the body of a PATCH or
 * PUT, as the record's GET gave it) is refused by the server with 409 edit_conflict when someone saved the record since. apiFetch hands such saves
 * here, which:
 *
 *  - runs saves of one record one at a time, and remembers which version each of this person's own saves produced, so a save that was based on
 *    a version this person has since moved on (an autosave, two quick edits before the screen refetched) is sent with the newer one instead of
 *    clashing with themselves;
 *  - on a conflict where nobody else changed a field this save changes, saves again on the new version and says so in a note
 *    ("Colin Brown also changed Severity; both changes kept");
 *  - where a field clashes, asks the person (the resolver registered by EditConflictHost: Keep yours / Take theirs per field), then saves what they
 *    kept on the new version, or answers with the record as it now is when they took everything of theirs; Cancel leaves their typing unsaved.
 *
 * A save without `rowVersion` is not touched: the last save wins, as before.
 */

export const EDIT_MERGED_EVENT = "qms:edit-merged";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const VERSION = /^[0-9]{1,20}$/;

/** The record a path saves: its last uuid (the route's :id), and the path up to it (where the record is read). */
export const recordKey = (path) => {
  const found = String(path ?? "").split("?")[0].match(UUID);
  return found ? found[found.length - 1].toLowerCase() : null;
};
export const recordPath = (path) => {
  const bare = String(path ?? "").split("?")[0];
  const key = recordKey(bare);
  if (!key) return null;
  const at = bare.toLowerCase().lastIndexOf(key);
  return bare.slice(0, at + key.length);
};

/** "quantityAffected" → "Quantity affected", "ownerId" → "Owner". */
export const fieldLabel = (field) => {
  const words = String(field)
    .split(".")
    .pop()
    .replace(/_/g, " ")
    .replace(/Id$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** "Title", "Title and Severity", "Title, Owner and Severity". */
export const listWords = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

// ---- this person's own saves -------------------------------------------------------------------------------------------------------------------

const moved = new Map(); // record key → Map(version saved on → version the save produced)
const queues = new Map(); // record key → the promise of the save running now

/** The newest version this person's own saves have taken `version` to. */
export const latestOwnVersion = (key, version) => {
  const steps = moved.get(key);
  let v = version;
  for (let i = 0; steps && steps.has(v) && i < 100; i += 1) v = steps.get(v);
  return v;
};
const remember = (key, from, to) => {
  if (!key || !VERSION.test(String(from ?? "")) || !VERSION.test(String(to ?? "")) || from === to) return;
  if (!moved.has(key)) moved.set(key, new Map());
  const steps = moved.get(key);
  steps.set(from, to);
  if (steps.size > 50) steps.delete(steps.keys().next().value);
};
const oneAtATime = (key, work) => {
  const before = queues.get(key) ?? Promise.resolve();
  const run = before.catch(() => undefined).then(work);
  queues.set(key, run);
  run.finally(() => queues.get(key) === run && queues.delete(key)).catch(() => undefined);
  return run;
};

/** For tests: forget every remembered save. */
export const resetEditConflicts = () => {
  moved.clear();
  queues.clear();
};

// ---- the person's choice -------------------------------------------------------------------------------------------------------------------------

let resolver = null;
/** EditConflictHost registers the dialog here; `fn({ clashes, changedBy, changedAt, people, current })` → { keepMine: [field…] } | null (cancel). */
export const setConflictResolver = (fn) => {
  resolver = fn;
  return () => {
    if (resolver === fn) resolver = null;
  };
};

const announce = (detail) => {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EDIT_MERGED_EVENT, { detail }));
};

// ---- comparing values -----------------------------------------------------------------------------------------------------------------------------

const idOf = (v) => (v && typeof v === "object" && !Array.isArray(v) && "id" in v ? v.id : v);
const same = (a, b) => {
  const x = idOf(a ?? null);
  const y = idOf(b ?? null);
  if (x === y) return true;
  if ((x === "" || x === null) && (y === "" || y === null)) return true;
  if (typeof x === "object" || typeof y === "object") return JSON.stringify(x) === JSON.stringify(y);
  return String(x) === String(y);
};
/** What the record now holds for a field the save sends (`ownerId` may come back as `owner: { id, name }`). */
export const currentValue = (record, field) => {
  if (!record || typeof record !== "object") return undefined;
  // a field inside a nested value, such as a custom field: "values.batch_ref"
  const dot = field.indexOf(".");
  if (dot > 0 && !(field in record)) return currentValue(record[field.slice(0, dot)], field.slice(dot + 1));
  if (field in record) return record[field];
  const base = field.replace(/Id$/, "");
  if (base !== field && base in record) return record[base];
  return undefined;
};

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v) && v.type !== "doc";
const named = (field, theirs) => theirs.has(field) || theirs.has(field.replace(/Id$/, "")) || theirs.has(`${field}Id`);

// ---- the save ------------------------------------------------------------------------------------------------------------------------------------

const theirsAnswers = new WeakSet();
/** True for the answer of a save where the person took everything of the other person's: nothing of theirs was written, the record is as it was. */
export const tookTheirs = (answer) => !!answer && typeof answer === "object" && theirsAnswers.has(answer);

export const isEditConflict = (error) => error?.status === 409 && error?.code === "edit_conflict";

/**
 * Runs a versioned save. `send(path, options)` is the plain request; `whoAmI()` gives the signed-in person's id (a clash only with their own
 * earlier save, in another tab, is not worth asking about: theirs is kept as they last typed it).
 */
export async function versionedSave(send, path, options, whoAmI = async () => null) {
  const key = recordKey(path);
  const { rowVersion, ...fields } = options.body ?? {};
  if (!key || !VERSION.test(String(rowVersion ?? ""))) return send(path, options);

  return oneAtATime(key, async () => {
    const attempt = async (version, body) => {
      const answer = await send(path, { ...options, body: { ...body, rowVersion: version } });
      remember(key, version, answer?.rowVersion);
      return answer;
    };
    const base = latestOwnVersion(key, rowVersion);
    try {
      return await attempt(base, fields);
    } catch (error) {
      if (!isEditConflict(error) || !error.details?.version) throw error;
      return settleConflict({ send, path, options, fields, error, attempt, whoAmI, base, key });
    }
  });
}

async function settleConflict({ send, path, options, fields, error, attempt, whoAmI, base, key }) {
  const details = error.details;
  const me = await whoAmI().catch(() => null);
  const others = (details.people ?? []).filter((p) => p?.id && p.id !== me);
  const theirFields = new Set(details.fields ?? []);
  // a nested value (custom fields: { values: { batch_ref: … } }) is compared field by field, as "values.batch_ref"
  const nested = (f) => isPlainObject(fields[f]) && [...theirFields].some((t) => t.startsWith(`${f}.`));
  const sent = Object.keys(fields).flatMap((f) => (nested(f) ? Object.keys(fields[f]).map((k) => `${f}.${k}`) : [f]));
  const mineOf = (f) => currentValue(fields, f);
  const theirsOnly = [...theirFields].filter((f) => !sent.some((s) => s === f || s.replace(/Id$/, "") === f || `${s}Id` === f));
  let candidates = sent.filter((f) => named(f, theirFields));
  let current = null;

  if (candidates.length) {
    const where = recordPath(path);
    current = where ? await send(where, { method: "GET", organisationId: options.organisationId }).catch(() => null) : null;
    // the same value on both sides is not a clash; neither is a field only this person has changed (another tab of theirs)
    if (current) candidates = candidates.filter((f) => !same(mineOf(f), currentValue(current, f)));
    if (!others.length) candidates = [];
  }

  const done = (answer, kept) => {
    // the screen's copy (its version plus this person's changes) now matches what was saved, unless they took the other person's values
    if (kept !== "theirs") remember(key, base, answer?.rowVersion);
    if (others.length) announce({ people: others, fields: theirsOnly, kept, changedAt: details.changedAt ?? null });
    return answer;
  };

  if (!candidates.length) return done(await attempt(details.version, fields), "both");

  if (!resolver) throw error;
  const clashes = candidates.map((field) => ({ field, label: fieldLabel(field), mine: mineOf(field), theirs: currentValue(current, field) }));
  const choice = await resolver({ clashes, changedBy: details.changedBy ?? null, changedAt: details.changedAt ?? null, people: others, current, path });
  if (!choice) {
    error.message = `Not saved: ${error.message}`;
    error.cancelled = true;
    throw error;
  }
  const keep = new Set(choice.keepMine ?? []);
  const dropped = candidates.filter((f) => !keep.has(f));
  const body = {};
  for (const [f, v] of Object.entries(fields)) {
    if (dropped.includes(f)) continue;
    if (nested(f)) {
      const inner = Object.fromEntries(Object.entries(v).filter(([k]) => !dropped.includes(`${f}.${k}`)));
      if (Object.keys(inner).length) body[f] = inner;
    } else body[f] = v;
  }
  // nothing of the person's own is left to write (what remains, such as the kind of record, is what the record already says)
  const writes = Object.keys(body).filter((f) => nested(f) || !current || !same(body[f], currentValue(current, f)));
  if (!writes.length) {
    const theirs = current ? { ...current } : null;
    if (theirs) theirsAnswers.add(theirs);
    return done(theirs, "theirs");
  }
  return done(await attempt(details.version, body), keep.size ? "mine" : "both");
}

/** A save's body with the version of the record the screen was showing, so a change made since is caught (nothing added when it has none). */
export const withVersion = (record, body) => (record?.rowVersion ? { ...body, rowVersion: record.rowVersion } : body);

/**
 * For a form that sends every field: the fields that differ from the record as the form opened it, with its version. Sending only what the person
 * changed lets someone else's change to another field stand, and keeps a clash to the fields both changed. When nothing can be told apart the whole
 * body goes, as before.
 */
export const changesSince = (opened, body) => {
  if (!opened?.rowVersion) return body;
  const changed = Object.fromEntries(Object.entries(body).filter(([field, value]) => {
    const was = currentValue(opened, field);
    return was === undefined || !same(value, was);
  }));
  return { ...(Object.keys(changed).length ? changed : body), rowVersion: opened.rowVersion };
};

// ---- values in words, for the dialog ---------------------------------------------------------------------------------------------------------

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_KEYS = ["name", "label", "fullName", "displayName", "title", "text", "description", "reference", "code", "email"];

export const nameOf = (o) => {
  if (!o || typeof o !== "object") return null;
  if (o.firstName || o.surname) return [o.firstName, o.surname].filter(Boolean).join(" ");
  for (const k of NAME_KEYS) if (typeof o[k] === "string" && o[k]) return o[k];
  return null;
};

/** The words of a rich-text (TipTap) document. */
export const docText = (node) => {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text ?? "";
  const inner = (node.content ?? []).map(docText);
  const block = ["paragraph", "heading", "listItem", "tableRow", "blockquote"].includes(node.type);
  return inner.join(block ? "" : "\n") + (block ? "\n" : "");
};
export const isDoc = (v) => !!v && typeof v === "object" && v.type === "doc";

/** A value in words for the choice. */
export const describeValue = (value, lookupName = () => null) => {
  if (value === null || value === undefined || value === "") return "Empty";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (isDoc(value)) return docText(value).trim() || "Empty";
  if (Array.isArray(value)) return value.length ? value.map((v) => describeValue(v, lookupName)).join(", ") : "Empty";
  if (typeof value === "object") return nameOf(value) ?? JSON.stringify(value);
  if (typeof value === "string" && ID_PATTERN.test(value)) return lookupName(value) ?? "Another choice";
  return String(value);
};

