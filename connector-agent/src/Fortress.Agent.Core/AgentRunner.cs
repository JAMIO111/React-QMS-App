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
    Func<TimeSpan, CancellationToken, Task>? delay = null)
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
                wait = TimeSpan.FromSeconds(Math.Clamp(beat.PollSeconds, 5, 300));
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (AgentApiException e) when (e.Revoked)
            {
                return Revoked(e.Message);
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
            var r = await api.ProgressAsync(identity, job.Id, progress, token);
            if (r.Cancelled) await jobCts.CancelAsync();
            return !r.Cancelled;
        }, clock);
        var started = Stopwatch.StartNew();
        try
        {
            var result = await handler.RunAsync(job, context, jobCts.Token);
            var done = await api.CompleteAsync(identity, job.Id, result, ct);
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

    private static string Bounded(string message) => message.Length <= 1000 ? message : message[..997] + "…";
}
