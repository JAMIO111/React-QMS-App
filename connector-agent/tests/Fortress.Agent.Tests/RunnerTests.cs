using System.Net;
using System.Text.Json.Nodes;
using Fortress.Agent.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Fortress.Agent.Tests;

public sealed class RunnerTests : IDisposable
{
    private readonly AgentIdentity id = TestIdentity.Make();
    private readonly FakeFortress fake = new();
    private readonly List<TimeSpan> waits = [];
    private readonly CancellationTokenSource stop = new();

    public RunnerTests() => fake.Verifier = TestIdentity.PublicHalf(id);

    public void Dispose()
    {
        id.Dispose();
        stop.Dispose();
    }

    /// <summary>A runner whose sleeps are recorded; it stops after <paramref name="cycles"/> sleeps.</summary>
    private AgentRunner Runner(int cycles = 1, JobHandlers? handlers = null) =>
        new(id, new AgentApiClient(new HttpClient(fake)), handlers ?? JobHandlers.Default(), NullLogger<AgentRunner>.Instance, null, (t, _) =>
        {
            waits.Add(t);
            if (waits.Count >= cycles) stop.Cancel();
            return Task.CompletedTask;
        });

    private void Beat(bool jobsWaiting = false, int poll = 60, bool revoked = false, bool fast = false) =>
        fake.Routes["/integrations/agent/heartbeat"] = _ => FakeFortress.Json(new
        {
            revoked, jobsWaiting, pollSeconds = poll, serverTime = DateTimeOffset.UtcNow, fastPollUntil = fast ? DateTimeOffset.UtcNow.AddMinutes(10) : (DateTimeOffset?)null,
        });

    private void Jobs(params AgentJob[] jobs)
    {
        var queue = new Queue<AgentJob>(jobs);
        fake.Routes["/integrations/agent/jobs/next"] = _ => queue.Count > 0 ? FakeFortress.Json(queue.Dequeue()) : FakeFortress.NoContent();
    }

    private void Reports(bool cancelledAtAck = false)
    {
        fake.Routes["/ack"] = _ => FakeFortress.Json(new { status = cancelledAtAck ? "cancelled" : "running", cancelled = cancelledAtAck });
        fake.Routes["/complete"] = _ => FakeFortress.Json(new { status = "completed", cancelled = false });
        fake.Routes["/fail"] = _ => FakeFortress.Json(new { status = "failed", cancelled = false });
        fake.Routes["/progress"] = _ => FakeFortress.Json(new { status = "running", cancelled = false });
    }

    private string[] Paths() => fake.Requests.Select(r => r.Path.Replace("/api/v1/integrations/agent/", "")).ToArray();

    [Fact]
    public async Task Heartbeats_does_a_ping_and_sleeps_as_long_as_fortress_says()
    {
        Beat(jobsWaiting: true, poll: 15);
        Jobs(new AgentJob { Id = "j1", Kind = "ping", Attempt = 1 });
        Reports();
        var outcome = await Runner().RunAsync(stop.Token);

        Assert.Equal(RunOutcome.Stopped, outcome);
        Assert.Equal(["heartbeat", "jobs/next", "jobs/j1/ack", "jobs/j1/complete", "jobs/next"], Paths());
        Assert.All(fake.Requests, r => Assert.True(r.SignatureValid, $"{r.Path} is not signed with the agent's key"));
        Assert.All(fake.Requests, r => Assert.Equal(id.AgentId, r.AgentId));
        var beat = JsonNode.Parse(fake.Requests[0].Body)!;
        Assert.Equal(AgentInfo.Version, beat["version"]!.GetValue<string>());
        var result = JsonNode.Parse(fake.Requests[3].Body)!["result"]!;
        Assert.True(result["pong"]!.GetValue<bool>());
        Assert.Equal(TimeSpan.FromSeconds(15), Assert.Single(waits));
    }

    [Fact]
    public async Task While_someone_is_waiting_it_looks_for_jobs_every_two_seconds_between_heartbeats()
    {
        Beat(fast: true, poll: 15);
        var calls = 0;
        // Nothing at first; a job appears while the agent is between heartbeats.
        fake.Routes["/integrations/agent/jobs/next"] = _ => ++calls == 3 ? FakeFortress.Json(new AgentJob { Id = "q1", Kind = "ping" }) : FakeFortress.NoContent();
        Reports();
        await Runner(cycles: 9).RunAsync(stop.Token);
        Assert.Equal(["heartbeat", "jobs/next", "jobs/next", "jobs/next", "jobs/q1/ack", "jobs/q1/complete"], Paths().Take(6));
        // Seven quick looks of 2 s, then the 1 s left until the next heartbeat at 15 s.
        Assert.Equal([2, 2, 2, 2, 2, 2, 2, 1], waits.Take(8).Select(w => (int)w.TotalSeconds));
        Assert.Equal(2, Paths().Count(p => p == "heartbeat"));
    }

    [Fact]
    public async Task With_nothing_waiting_it_still_looks_once_per_heartbeat()
    {
        Beat();
        Jobs();
        await Runner().RunAsync(stop.Token);
        Assert.Equal(["heartbeat", "jobs/next"], Paths());
        Assert.Equal(TimeSpan.FromSeconds(60), waits[0]);
    }

    [Fact]
    public async Task Stops_for_good_when_fortress_says_it_is_revoked()
    {
        Beat(revoked: true);
        Assert.Equal(RunOutcome.Revoked, await Runner(cycles: 5).RunAsync(stop.Token));
        Assert.Equal(["heartbeat"], Paths());
        Assert.Empty(waits);

        fake.Requests.Clear();
        fake.Routes["/integrations/agent/heartbeat"] = _ => FakeFortress.Error(HttpStatusCode.Unauthorized, "agent_revoked", "This agent has been revoked");
        Assert.Equal(RunOutcome.Revoked, await Runner(cycles: 5).RunAsync(stop.Token));
    }

    [Fact]
    public async Task Backs_off_while_fortress_cannot_be_reached_then_carries_on()
    {
        var calls = 0;
        fake.Routes["/integrations/agent/heartbeat"] = _ => ++calls <= 2
            ? throw new HttpRequestException("No such host is known")
            : FakeFortress.Json(new { revoked = false, jobsWaiting = false, pollSeconds = 60 });
        Jobs();
        await Runner(cycles: 3).RunAsync(stop.Token);
        Assert.Equal(3, waits.Count);
        Assert.InRange(waits[0].TotalSeconds, 5, 6);
        Assert.InRange(waits[1].TotalSeconds, 10, 12);
        Assert.Equal(TimeSpan.FromSeconds(60), waits[2]);
    }

    [Fact]
    public async Task Waits_as_long_as_the_server_asks_when_rate_limited_and_never_more_than_five_minutes()
    {
        fake.Routes["/integrations/agent/heartbeat"] = _ =>
        {
            var res = FakeFortress.Error(HttpStatusCode.TooManyRequests, "rate_limited", "Too many requests");
            res.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(90));
            return res;
        };
        await Runner().RunAsync(stop.Token);
        Assert.Equal(TimeSpan.FromSeconds(90), waits[0]);
        var runner = Runner();
        for (var i = 0; i < 20; i++) runner.Backoff(null);
        Assert.True(runner.Backoff(null) <= AgentRunner.MaxBackoff * 1.2);
        Assert.Equal(AgentRunner.MaxBackoff, runner.Backoff(TimeSpan.FromHours(1)));
    }

    [Fact]
    public async Task A_job_it_cannot_do_is_failed_with_words_to_update_the_agent()
    {
        Beat(jobsWaiting: true);
        Jobs(new AgentJob { Id = "j2", Kind = "extract" });
        Reports();
        await Runner().RunAsync(stop.Token);
        Assert.Contains("jobs/j2/fail", Paths());
        var fail = JsonNode.Parse(fake.Requests.Single(r => r.Path.EndsWith("/fail")).Body)!;
        Assert.Equal("invalid", fail["kind"]!.GetValue<string>());
        Assert.Contains("cannot do \"extract\" jobs", fail["message"]!.GetValue<string>());
        Assert.False(fail["transient"]!.GetValue<bool>());
    }

    private sealed class Throws(Exception e) : IJobHandler
    {
        public string Kind => "ping";
        public Task<JsonNode?> RunAsync(AgentJob job, JobContext context, CancellationToken ct) => throw e;
    }

    [Fact]
    public async Task An_unexpected_error_is_reported_without_its_details()
    {
        Beat(jobsWaiting: true);
        Jobs(new AgentJob { Id = "j3", Kind = "ping" });
        Reports();
        await Runner(handlers: new JobHandlers([new Throws(new InvalidOperationException("Server=erp;Password=hunter2"))])).RunAsync(stop.Token);
        var fail = fake.Requests.Single(r => r.Path.EndsWith("/fail")).Body;
        Assert.DoesNotContain("hunter2", fail);
        Assert.Contains("InvalidOperationException", fail);
        Assert.Contains("\"kind\":\"internal\"", fail);
    }

    [Fact]
    public async Task A_handler_failure_says_why_in_its_own_words()
    {
        Beat(jobsWaiting: true);
        Jobs(new AgentJob { Id = "j4", Kind = "ping" });
        Reports();
        await Runner(handlers: new JobHandlers([new Throws(new JobFailedException("auth", "The database refused the sign-in", transient: false))])).RunAsync(stop.Token);
        var fail = JsonNode.Parse(fake.Requests.Single(r => r.Path.EndsWith("/fail")).Body)!;
        Assert.Equal("auth", fail["kind"]!.GetValue<string>());
        Assert.Equal("The database refused the sign-in", fail["message"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_job_cancelled_before_it_starts_is_left_alone()
    {
        Beat(jobsWaiting: true);
        Jobs(new AgentJob { Id = "j5", Kind = "ping" });
        Reports(cancelledAtAck: true);
        await Runner().RunAsync(stop.Token);
        Assert.Contains("jobs/j5/ack", Paths());
        Assert.DoesNotContain(Paths(), p => p.EndsWith("/complete") || p.EndsWith("/fail"));
    }

    private sealed class Slow : IJobHandler
    {
        public string Kind => "ping";
        public async Task<JsonNode?> RunAsync(AgentJob job, JobContext context, CancellationToken ct)
        {
            for (var i = 0; i < 5; i++)
            {
                if (!await context.ReportProgressAsync(new JsonObject { ["rows"] = i }, ct)) ct.ThrowIfCancellationRequested();
            }
            return new JsonObject { ["done"] = true };
        }
    }

    [Fact]
    public async Task Stops_a_running_job_when_fortress_answers_progress_with_cancelled()
    {
        Beat(jobsWaiting: true);
        Jobs(new AgentJob { Id = "j6", Kind = "ping" });
        Reports();
        var progress = 0;
        fake.Routes["/progress"] = _ => FakeFortress.Json(new { status = ++progress >= 2 ? "cancelled" : "running", cancelled = progress >= 2 });
        await Runner(handlers: new JobHandlers([new Slow()])).RunAsync(stop.Token);
        Assert.Equal(2, progress);
        Assert.DoesNotContain(Paths(), p => p.EndsWith("/complete") || p.EndsWith("/fail"));
    }

    [Fact]
    public async Task Does_at_most_ten_jobs_before_the_next_heartbeat()
    {
        Beat(jobsWaiting: true);
        Jobs(Enumerable.Range(0, 15).Select(i => new AgentJob { Id = $"q{i}", Kind = "ping" }).ToArray());
        Reports();
        await Runner().RunAsync(stop.Token);
        Assert.Equal(AgentRunner.JobsPerCycle, Paths().Count(p => p.EndsWith("/complete")));
    }

    [Fact]
    public async Task A_job_keeps_its_work_when_fortress_cannot_be_reached_for_a_moment()
    {
        // The result cannot be sent twice (a 503, then the connection refused), then gets through: the ping is not done again, and the
        // agent waited 1 s and 2 s inside the job rather than dropping it until its lease ran out.
        Beat(jobsWaiting: true, poll: 15);
        Jobs(new AgentJob { Id = "j1", Kind = "ping", Attempt = 1 });
        Reports();
        var tries = 0;
        fake.Routes["/complete"] = _ => ++tries switch
        {
            1 => FakeFortress.Error(HttpStatusCode.ServiceUnavailable, "unavailable", "Down for a moment"),
            2 => throw new HttpRequestException("Connection refused"),
            _ => FakeFortress.Json(new { status = "completed", cancelled = false }),
        };
        var outcome = await Runner(cycles: 3).RunAsync(stop.Token);

        Assert.Equal(RunOutcome.Stopped, outcome);
        Assert.Equal(3, tries);
        Assert.Equal(["heartbeat", "jobs/next", "jobs/j1/ack", "jobs/j1/complete", "jobs/j1/complete", "jobs/j1/complete", "jobs/next"], Paths());
        Assert.Equal([TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(15)], waits);
    }

    [Fact]
    public async Task A_refusal_that_will_not_pass_is_not_tried_again_inside_the_job()
    {
        Beat(jobsWaiting: true, poll: 15);
        Jobs(new AgentJob { Id = "j1", Kind = "ping", Attempt = 1 });
        Reports();
        var tries = 0;
        fake.Routes["/complete"] = _ => { tries++; return FakeFortress.Error(HttpStatusCode.Conflict, "integration_rule", "This job has ended"); };
        await Runner(cycles: 1).RunAsync(stop.Token);
        Assert.Equal(1, tries);
    }
}
