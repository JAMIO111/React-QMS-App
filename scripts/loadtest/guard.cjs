/**
 * The safety rules of the load test harness. Nothing here talks to a database: it decides, from addresses alone, whether a target is allowed, and
 * (separately, once a connection exists) whether the database is empty of real organisations. The harness refuses to start on any "no".
 *
 * Rules, in the order they are checked:
 *  1. The live Fortress project and its public addresses are never a target, whatever else is set (DENY_MARKERS).
 *  2. A local database (localhost, 127.0.0.1, ::1, or a socket directory) is allowed.
 *  3. Anything else needs BOTH LOADTEST_ALLOW_HOST=<its exact host> and LOADTEST_CONFIRM=<the same host>, and must be set through
 *     LOADTEST_DATABASE_URL / LOADTEST_ADMIN_URL (the harness never reads a remote DATABASE_URL by accident).
 *  4. Before it writes anything the harness checks the database holds no organisation outside its own (slug "loadtest-…"): a database with real
 *     data is refused even when every address check passed (assertEmptyOfRealOrganisations).
 */

/** Strings that mark the live system. Matched against the whole connection string, user name included (the pooler user is `qms_api.<project ref>`). */
const DENY_MARKERS = ['xvpgrmujayytbbmhnoan', 'fortress-qms.com'];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

/** Pulls the host (and the `host=` socket directory some local URLs carry) out of a connection string without throwing on odd input. */
function describe(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { host: null, socketDir: null, raw: String(url ?? '') };
  }
  return { host: decodeURIComponent(parsed.hostname).toLowerCase(), socketDir: parsed.searchParams.get('host'), raw: String(url) };
}

function isLocal(d) {
  if (d.host === null) return false;
  if (!LOCAL_HOSTS.has(d.host)) return false;
  // `?host=<dir>` is a socket directory; `?host=db.example.com` would send the connection elsewhere, so only a path counts as local.
  return d.socketDir === null || d.socketDir.startsWith('/');
}

/**
 * Decides whether `url` may be used. `env` is process.env (injectable for tests). Returns { ok: true, local } or { ok: false, reason }.
 */
function checkTarget(url, env = process.env, what = 'database') {
  if (!url) return { ok: false, reason: `No ${what} address was given.` };
  const d = describe(url);
  if (d.host === null) return { ok: false, reason: `The ${what} address could not be read.` };
  const hay = d.raw.toLowerCase();
  for (const marker of DENY_MARKERS) {
    if (hay.includes(marker)) return { ok: false, reason: `The ${what} address names the live Fortress system ("${marker}"). The harness never runs against it.` };
  }
  if (isLocal(d)) return { ok: true, local: true };
  const allow = (env.LOADTEST_ALLOW_HOST ?? '').trim().toLowerCase();
  const confirm = (env.LOADTEST_CONFIRM ?? '').trim().toLowerCase();
  if (!allow || allow !== d.host) {
    return { ok: false, reason: `The ${what} host "${d.host}" is not local. Set LOADTEST_ALLOW_HOST=${d.host} AND LOADTEST_CONFIRM=${d.host} to run against a separate test project.` };
  }
  if (confirm !== d.host) return { ok: false, reason: `LOADTEST_CONFIRM must repeat the host ("${d.host}") before the harness will write to it.` };
  return { ok: true, local: false };
}

/**
 * The two addresses the harness uses: the API's login (DATABASE_URL for the child API process) and an administrator login (for seeding and
 * measuring). Local runs started through scripts/db-check.sh already have DATABASE_URL and DATABASE_ADMIN_URL; a remote run must use the
 * LOADTEST_ variables, so a stray production DATABASE_URL in the shell can never be picked up.
 */
function resolveTargets(env = process.env) {
  const explicitUrl = env.LOADTEST_DATABASE_URL;
  const explicitAdmin = env.LOADTEST_ADMIN_URL;
  const url = explicitUrl ?? env.DATABASE_URL;
  const adminUrl = explicitAdmin ?? env.DATABASE_ADMIN_URL;
  const problems = [];
  const api = checkTarget(url, env, 'API database');
  const admin = checkTarget(adminUrl, env, 'administrator database');
  if (!api.ok) problems.push(api.reason);
  if (!admin.ok) problems.push(admin.reason);
  // A URL taken from the ordinary variables must be local: remote targets are accepted only when named explicitly.
  if (api.ok && !api.local && !explicitUrl) problems.push('A remote API database must be given as LOADTEST_DATABASE_URL, not DATABASE_URL.');
  if (admin.ok && !admin.local && !explicitAdmin) problems.push('A remote administrator database must be given as LOADTEST_ADMIN_URL, not DATABASE_ADMIN_URL.');
  if (problems.length) return { ok: false, problems };
  return { ok: true, url, adminUrl, local: api.local && admin.local };
}

const SLUG_PREFIX = 'loadtest-';

/** The last check, with a live connection: refuse a database that holds any organisation the harness did not make. */
async function assertEmptyOfRealOrganisations(adminPool) {
  const { rows } = await adminPool.query(`select count(*)::int as n from public.organisations where slug not like $1`, [`${SLUG_PREFIX}%`]);
  if (rows[0].n > 0) {
    throw new Error(`Refusing to run: this database holds ${rows[0].n} organisation(s) that are not load test data. Point the harness at a fresh, empty database.`);
  }
}

module.exports = { checkTarget, resolveTargets, assertEmptyOfRealOrganisations, DENY_MARKERS, SLUG_PREFIX, describe };
