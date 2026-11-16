using System.Diagnostics;
using Microsoft.Extensions.Logging;

namespace Fortress.Agent.Core;

/// <summary>How a run of the agent ended.</summary>
public enum RunOutcome
{
    /// <summary>Asked to stop (the service was stopped).</summary>
    Stopped,
    /// <summary>Fortress says this agent is revoked. It must not keep calling; it needs registering again.</summary>
    Revoked,
}

/// <summary>
/// The agent's loop: heartbeat, take and do the jobs waiting for it, sleep as long as Fortress says (15 seconds while someone is looking at
/// the agent or jobs are waiting, else 60), and back off when Fortress cannot be reached. Revocation stops it for good.
/// </summary>
public sealed class AgentRunner(
    AgentIdentity identity,
    AgentApiClient api,
    JobHandlers handlers,
    ILogger<AgentRunner> logger,
    TimeProvider? clock = null,
    Func<TimeSpan, CancellationToken, Task>? delay = null,
    KeyRotation? rotation = null)
{
    private readonly TimeProvider clock = clock ?? TimeProvider.System;
    private readonly Func<TimeSpan, CancellationToken, Task> delay = delay ?? ((t, ct) => Task.Delay(t, ct));
    private readonly Stopwatch uptime = Stopwatch.StartNew();
    private int failures;

    /// <summary>Jobs done in one go before the next heartbeat, so a long queue never hides the agent.</summary>
    public const int JobsPerCycle = 10;

    public static readonly TimeSpan MaxBackoff = TimeSpan.FromMinutes(5);

    public async Task<RunOutcome> RunAsync(CancellationToken ct)
    {
        logger.LogInformation("Fortress Connector Agent {Version} started as {Name} ({AgentId}) for {Organisation}; Fortress at {Api}; key {Fingerprint}",
            AgentInfo.Version, identity.Name, identity.AgentId, identity.OrganisationName, identity.ApiUrl, identity.Fingerprint);
        while (!ct.IsCancellationRequested)
        {
            TimeSpan wait;
            try
            {
                var beat = await api.HeartbeatAsync(identity, Heartbeat(), ct);
                if (beat.Revoked) return Revoked("Fortress says this agent has been revoked");
                if (failures > 0) logger.LogInformation("Fortress can be reached again");
                failures = 0;
                WarnAboutClock(beat.ServerTime);
                if (beat.JobsWaiting || beat.FastPollUntil is not null) await DrainJobsAsync(ct);
                else await DrainJobsAsync(ct, max: 1);
                // Keys older than 90 days (or a rotation that did not finish) are replaced between jobs (AG6a).
                if (rotation is not null && rotation.Due(identity)) await RotateQuietlyAsync(ct);
                wait = TimeSpan.FromSeconds(Math.Clamp(beat.PollSeconds, 5, 300));
                // Someone has the agent's or a connection's page open: look for their next job every few seconds until the next heartbeat,
                // so a test, a browse or a preview answers in seconds rather than on the next poll.
                if (beat.FastPollUntil is not null) wait = await QuickPollAsync(wait, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (AgentApiException e) when (e.Revoked)
            {
                return Revoked(e.Message);
            }
            catch (AgentApiException e) when (e.Code == "agent_unauthenticated" && rotation is not null && rotation.TryRecover(identity))
            {
                // Fortress already holds the keys of a rotation this agent wrote down and did not finish: carry on with them at once.
                wait = TimeSpan.FromSeconds(1);
            }
            catch (AgentApiException e)
            {
                wait = Backoff(e.RetryAfter);
                logger.LogWarning("Fortress refused the agent ({Code}, {Status}): {Message}. Trying again in {Wait}s", e.Code, e.Status, e.Message, (int)wait.TotalSeconds);
            }
            catch (AgentNetworkException e)
            {
                wait = Backoff(null);
                logger.LogWarning("{Message}. Trying again in {Wait}s", e.Message, (int)wait.TotalSeconds);
            }
            try
            {
                await delay(wait, ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
        logger.LogInformation("Fortress Connector Agent stopping");
        return RunOutcome.Stopped;
    }

    /// <summary>How often to look for jobs while someone is waiting on one (heartbeats stay every poll interval).</summary>
    public static readonly TimeSpan QuickPoll = TimeSpan.FromSeconds(2);

    /// <summary>Look for jobs every <see cref="QuickPoll"/> for most of <paramref name="interval"/>; returns what is left to wait before the next heartbeat.</summary>
    private async Task<TimeSpan> QuickPollAsync(TimeSpan interval, CancellationToken ct)
    {
        var left = interval;
        while (left > QuickPoll && !ct.IsCancellationRequested)
        {
            await delay(QuickPoll, ct);
            left -= QuickPoll;
            await DrainJobsAsync(ct);
        }
        return left;
    }

    private async Task RotateQuietlyAsync(CancellationToken ct)
    {
        try
        {
            await rotation!.RotateAsync(identity, api, ct);
        }
        catch (Exception e) when (e is AgentApiException { Revoked: false } or AgentNetworkException)
        {
            logger.LogWarning("The keys could not be rotated now ({Message}); trying again later", e.Message);
        }
    }

    private RunOutcome Revoked(string why)
    {
        logger.LogError("{Why}. The agent will not connect again; register it afresh with a new token from Fortress (Settings → Integrations → Connector agents).", why);
        return RunOutcome.Revoked;
    }

    private HeartbeatRequest Heartbeat() =>
        new(AgentInfo.Version, AgentInfo.OperatingSystem, AgentInfo.Machine, handlers.Capabilities(), (long)uptime.Elapsed.TotalSeconds);

    /// <summary>1, 2, 4… seconds × 5 up to five minutes, with up to 20% jitter, or the server's Retry-After when it gives one.</summary>
    internal TimeSpan Backoff(TimeSpan? retryAfter)
    {
        failures++;
        if (retryAfter is { } r && r > TimeSpan.Zero) return r < MaxBackoff ? r : MaxBackoff;
        var seconds = Math.Min(MaxBackoff.TotalSeconds, 5 * Math.Pow(2, Math.Min(failures - 1, 10)));
        return TimeSpan.FromSeconds(seconds * (1 + Random.Shared.NextDouble() * 0.2));
    }

    private void WarnAboutClock(DateTimeOffset? serverTime)
    {
        if (serverTime is not { } server) return;
        var skew = clock.GetUtcNow() - server;
        if (Math.Abs(skew.TotalSeconds) > 120)
            logger.LogWarning("This machine's clock is {Seconds:+0;-0}s away from Fortress's. Over 300s and Fortress refuses the agent: set the time to sync automatically.", skew.TotalSeconds);
    }

    private async Task DrainJobsAsync(CancellationToken ct, int max = JobsPerCycle)
    {
        for (var i = 0; i < max && !ct.IsCancellationRequested; i++)
        {
            var job = await api.NextJobAsync(identity, ct);
            if (job is null) return;
            await RunJobAsync(job, ct);
        }
    }

    internal async Task RunJobAsync(AgentJob job, CancellationToken ct)
    {
        var handler = handlers.For(job.Kind);
        logger.LogInformation("Job {JobId}: {Kind} (attempt {Attempt})", job.Id, job.Kind, job.Attempt);
        var ack = await api.AckAsync(identity, job.Id, ct);
        if (ack.Cancelled)
        {
            logger.LogInformation("Job {JobId} was cancelled in Fortress before it started", job.Id);
            return;
        }
        // Rotating the keys changes what this agent signs with, so the runner does it itself (AG6a).
        if (job.Kind == "rotate_keys" && rotation is not null)
        {
            try
            {
                var fingerprint = await rotation.RotateAsync(identity, api, ct);
                await api.CompleteAsync(identity, job.Id, new System.Text.Json.Nodes.JsonObject { ["rotated"] = true, ["fingerprint"] = fingerprint }, ct);
            }
            catch (AgentApiException e) when (!e.Revoked)
            {
                await api.FailAsync(identity, job.Id, new JobFailure("refused", Bounded($"Fortress refused the new keys: {e.Message}"), false), ct);
            }
            return;
        }
        if (handler is null)
        {
            await api.FailAsync(identity, job.Id,
                new JobFailure("invalid", $"This agent (version {AgentInfo.Version}) cannot do \"{job.Kind}\" jobs. Update the agent.", false), ct);
            logger.LogWarning("Job {JobId}: this agent has no handler for {Kind}", job.Id, job.Kind);
            return;
        }
        using var jobCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var context = new JobContext(async (progress, token) =>
        {
            var r = await PatientlyAsync(() => api.ProgressAsync(identity, job.Id, progress, token), "progress", token);
            if (r.Cancelled) await jobCts.CancelAsync();
            return !r.Cancelled;
        }, clock, async (batch, token) =>
        {
            // Sending the same batch again is safe: Fortress keeps a batch once and accepts the same rows again (AG3).
            var r = await PatientlyAsync(() => api.SendBatchAsync(identity, job.Id, batch, token), $"batch {batch.Seq}", token);
            if (r.Cancelled) await jobCts.CancelAsync();
            return r;
        }, async (part, token) =>
        {
            var r = await PatientlyAsync(() => api.SendFilePartAsync(identity, job.Id, part, token), "file part", token);
            if (r.Cancelled) await jobCts.CancelAsync();
            return r;
        });
        var started = Stopwatch.StartNew();
        try
        {
            var result = await handler.RunAsync(job, context, jobCts.Token);
            var done = await PatientlyAsync(() => api.CompleteAsync(identity, job.Id, result, ct), "the result", ct);
            logger.LogInformation("Job {JobId} done in {Ms} ms ({Status})", job.Id, started.ElapsedMilliseconds, done.Status);
        }
        catch (OperationCanceledException) when (jobCts.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            logger.LogInformation("Job {JobId} was cancelled in Fortress", job.Id);
        }
        catch (JobFailedException e)
        {
            await api.FailAsync(identity, job.Id, new JobFailure(e.Kind, Bounded(e.Message), e.Transient), ct);
            logger.LogWarning("Job {JobId} failed ({Kind}): {Message}", job.Id, e.Kind, e.Message);
        }
        catch (Exception e) when (e is not (OperationCanceledException or AgentApiException or AgentNetworkException))
        {
            // Never send an exception's details: they can carry connection strings. The type is enough to start looking; the log has the rest.
            await api.FailAsync(identity, job.Id, new JobFailure("internal", $"The agent hit an unexpected error ({e.GetType().Name}). See the agent's log.", true), ct);
            logger.LogError(e, "Job {JobId} hit an unexpected error", job.Id);
        }
    }

    /// <summary>Waits between attempts while a job's call to Fortress fails for a passing reason: about three minutes in all, inside the job's lease.</summary>
    internal static readonly TimeSpan[] JobRetryWaits =
        [TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(4), TimeSpan.FromSeconds(8), TimeSpan.FromSeconds(16),
         TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30)];

    /// <summary>
    /// A call a running job makes to Fortress (progress, a batch, a file part, the result), tried again while Fortress cannot be reached or answers
    /// with a passing error (AG6a, AG6-D5), so a short outage does not throw away work already read. Each attempt is signed afresh. After the last
    /// wait the error goes up and the job is taken again once its lease runs out (it resumes from the last batch Fortress kept).
    /// </summary>
    internal async Task<T> PatientlyAsync<T>(Func<Task<T>> call, string what, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                return await call();
            }
            catch (Exception e) when (attempt < JobRetryWaits.Length && e is AgentNetworkException or AgentApiException { Revoked: false, Transient: true })
            {
                var wait = e is AgentApiException { RetryAfter: { } ra } && ra > TimeSpan.Zero && ra < MaxBackoff ? ra : JobRetryWaits[attempt];
                logger.LogWarning("Could not send {What} to Fortress ({Message}); trying again in {Wait}s", what, e.Message, (int)wait.TotalSeconds);
                await delay(wait, ct);
            }
        }
    }

    private static string Bounded(string message) => message.Length <= 1000 ? message : message[..997] + "…";
}
