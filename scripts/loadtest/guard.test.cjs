// Run with: node --test scripts/loadtest/guard.test.cjs   (no database, no network)
const test = require('node:test');
const assert = require('node:assert');
const { checkTarget, resolveTargets } = require('./guard.cjs');

const LIVE_DIRECT = 'postgresql://postgres:x@db.xvpgrmujayytbbmhnoan.supabase.co:5432/postgres';
const LIVE_POOLER = 'postgresql://qms_api.xvpgrmujayytbbmhnoan:x@aws-0-eu-west-2.pooler.supabase.com:6543/postgres';
const LOCAL = 'postgresql://qms_api@localhost:54329/postgres?host=/tmp/tmp.abc123';

test('the live project is refused however it is addressed, even with every override set', () => {
  const env = { LOADTEST_ALLOW_HOST: 'db.xvpgrmujayytbbmhnoan.supabase.co', LOADTEST_CONFIRM: 'db.xvpgrmujayytbbmhnoan.supabase.co' };
  assert.strictEqual(checkTarget(LIVE_DIRECT, env).ok, false);
  assert.strictEqual(checkTarget(LIVE_POOLER, { LOADTEST_ALLOW_HOST: 'aws-0-eu-west-2.pooler.supabase.com', LOADTEST_CONFIRM: 'aws-0-eu-west-2.pooler.supabase.com' }).ok, false);
  assert.strictEqual(checkTarget('postgresql://x@api.fortress-qms.com/db', {}).ok, false);
});

test('a local database and a local socket are allowed without overrides', () => {
  assert.deepStrictEqual(checkTarget(LOCAL, {}), { ok: true, local: true });
  assert.deepStrictEqual(checkTarget('postgresql://u@127.0.0.1:5432/db', {}), { ok: true, local: true });
});

test('a socket parameter that is a host name is not local', () => {
  assert.strictEqual(checkTarget('postgresql://u@localhost/db?host=db.example.com', {}).ok, false);
});

test('a remote host needs the allow and the confirm, both exactly the host', () => {
  const url = 'postgresql://u:p@db.testproject.supabase.co:5432/postgres';
  assert.strictEqual(checkTarget(url, {}).ok, false);
  assert.strictEqual(checkTarget(url, { LOADTEST_ALLOW_HOST: 'db.testproject.supabase.co' }).ok, false);
  assert.strictEqual(checkTarget(url, { LOADTEST_ALLOW_HOST: 'db.testproject.supabase.co', LOADTEST_CONFIRM: 'db.other.supabase.co' }).ok, false);
  assert.deepStrictEqual(checkTarget(url, { LOADTEST_ALLOW_HOST: 'db.testproject.supabase.co', LOADTEST_CONFIRM: 'db.testproject.supabase.co' }), { ok: true, local: false });
});

test('nothing, or nonsense, is refused', () => {
  assert.strictEqual(checkTarget(undefined, {}).ok, false);
  assert.strictEqual(checkTarget('not a url', {}).ok, false);
});

test('a remote address in the ordinary DATABASE_URL is never picked up', () => {
  const env = { DATABASE_URL: 'postgresql://u@db.testproject.supabase.co/postgres', DATABASE_ADMIN_URL: LOCAL, LOADTEST_ALLOW_HOST: 'db.testproject.supabase.co', LOADTEST_CONFIRM: 'db.testproject.supabase.co' };
  const r = resolveTargets(env);
  assert.strictEqual(r.ok, false);
  assert.match(r.problems.join(' '), /LOADTEST_DATABASE_URL/);
});

test('local targets from db-check.sh are accepted as they come', () => {
  const r = resolveTargets({ DATABASE_URL: LOCAL, DATABASE_ADMIN_URL: LOCAL.replace('qms_api', 'postgres') });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.local, true);
});
