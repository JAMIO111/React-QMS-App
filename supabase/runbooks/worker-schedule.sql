-- Runbook: wake the background worker every minute (docs/workflow-engine-plan.md, WK1, decision W1).
--
-- Run in the Supabase SQL editor AFTER the migration 20260219100000_worker_foundation.sql. Not a migration: local test databases have neither
-- pg_cron nor pg_net, and the address and secret belong to the live project only. Safe to run again (each step replaces what was there).
--
-- Before you start:
--   * CRON_SECRET must be set on the qms-api Vercel project (20+ characters) — the same value goes into Vault below. Without it the tick answers 503.
--   * The address is the API deployment pg_cron should call. There is one Supabase project, so it calls ONE deployment: the Dev branch alias today,
--     production once it exists (change the secret 'worker_tick_url' with vault.update_secret; nothing else changes).
--   * qms-api must not have Vercel deployment protection on (it has none today), or every call answers 401 from Vercel itself.

-- 1. The extensions (Supabase puts pg_cron in the `cron` schema and pg_net in `net`).
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. The address and the secret, in Vault (never in a table, a migration or git). Replace the two placeholders.
--    First time: create. Later changes: SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'worker_tick_url'), '<new value>');
SELECT vault.create_secret(
  'https://qms-api-git-dev-jamie-drydens-projects.vercel.app/api/v1/internal/worker/tick?source=pg_cron&budgetMs=40000',
  'worker_tick_url', 'Fortress QMS: the API worker tick pg_cron calls every minute');
SELECT vault.create_secret('<the CRON_SECRET value from Vercel>', 'worker_cron_secret', 'Fortress QMS: Bearer secret for the worker tick');

-- 3. The schedule: every minute, an asynchronous POST (pg_net never holds a database connection while it waits). A tick works for up to 40 s
--    (budgetMs above; lower it if the API's function time limit is shorter); one that is still working makes the next one record itself as skipped.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'fortress-worker-tick';
SELECT cron.schedule('fortress-worker-tick', '* * * * *', $job$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'worker_tick_url'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'worker_cron_secret'),
      'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000)
$job$);

-- 4. Checks (a minute or two later).
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'fortress-worker-tick';
SELECT status, return_message, start_time FROM cron.job_run_details
 WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'fortress-worker-tick') ORDER BY start_time DESC LIMIT 5;
-- What the API answered (200 with {"skipped": false, "outcome": "done", ...} is right; 401 = secrets differ; 503 = CRON_SECRET not set on Vercel):
SELECT id, status_code, left(content, 300) AS answer, error_msg, created FROM net._http_response ORDER BY created DESC LIMIT 5;
-- What the worker recorded:
SELECT id, source, outcome, started_at, finished_at, error FROM app.worker_ticks ORDER BY started_at DESC LIMIT 5;

-- To stop the worker:   SELECT cron.unschedule('fortress-worker-tick');
