using System.Net.Sockets;
using Fortress.Agent.Adapters;
using Npgsql;

namespace Fortress.Agent.Tests;

/// <summary>
/// AG6a (AG6-D5): a database that drops the agent's connection (a restart, a broken network, too many connections) is a passing problem, so the
/// extraction is tried again within its attempts and resumes; a refusal the database means (bad sign-in, no right, a bad query) is not.
/// </summary>
public sealed class AdapterErrorTests
{
    private static PostgresException Pg(string state) => new("message", "FATAL", "FATAL", state);

    [Theory]
    [InlineData("57P01")] // terminating connection due to administrator command (a restart)
    [InlineData("57P02")]
    [InlineData("57P03")] // the database system is starting up
    [InlineData("08006")]
    [InlineData("53300")]
    [InlineData("40P01")]
    public void A_lost_postgres_connection_is_worth_another_attempt(string state)
    {
        var e = PostgresAdapter.Translate(Pg(state), null);
        Assert.True(e.Transient);
        Assert.Equal("network", e.Kind);
        Assert.Contains("connection was lost", e.Message);
    }

    [Theory]
    [InlineData("28P01", "auth")]
    [InlineData("42501", "refused")]
    [InlineData("42P01", "refused")]
    public void A_refusal_postgres_means_is_not_tried_again(string state, string kind)
    {
        var e = PostgresAdapter.Translate(Pg(state), null);
        Assert.False(e.Transient);
        Assert.Equal(kind, e.Kind);
    }

    [Fact]
    public void An_unreachable_server_or_a_broken_socket_is_worth_another_attempt()
    {
        Assert.True(PostgresAdapter.Translate(new NpgsqlException("x", new SocketException((int)SocketError.ConnectionReset)), null).Transient);
        Assert.True(PostgresAdapter.Translate(new NpgsqlException("Exception while reading from stream"), null).Transient);
        Assert.True(PostgresAdapter.Translate(new TimeoutException(), null).Transient);
    }
}
