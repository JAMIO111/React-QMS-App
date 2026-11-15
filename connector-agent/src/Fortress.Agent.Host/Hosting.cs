using System.Net;
using Fortress.Agent.Core;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Serilog;
using Serilog.Events;

namespace Fortress.Agent.Host;

/// <summary>Where the agent keeps its identity and logs.</summary>
public sealed record AgentPaths(string Root)
{
    public string IdentityFile => Path.Combine(Root, "agent.json");
    public string LogFolder => Path.Combine(Root, "logs");
    /// <summary>Database passwords this agent holds, one protected file per connection.</summary>
    public string CredentialsFolder => Path.Combine(Root, "credentials");
    /// <summary>The customer's own limit on what this agent may read (optional).</summary>
    public string AllowListFile => Path.Combine(Root, "allowlist.json");

    public static AgentPaths From(string? dataDir)
    {
        if (!string.IsNullOrWhiteSpace(dataDir)) return new AgentPaths(Path.GetFullPath(dataDir));
        if (OperatingSystem.IsWindows())
            return new AgentPaths(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Fortress", "ConnectorAgent"));
        var home = Environment.GetEnvironmentVariable("FORTRESS_AGENT_HOME");
        return new AgentPaths(!string.IsNullOrWhiteSpace(home) ? home : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".fortress-agent"));
    }
}

public static class Logging
{
    /// <summary>
    /// A daily log file kept 14 days (and the console when someone is watching). The log never holds tokens, keys, passwords or row contents:
    /// the agent only ever logs ids, kinds, counts and Fortress's own messages.
    /// </summary>
    public static Serilog.ILogger Create(AgentPaths paths, bool interactive)
    {
        Directory.CreateDirectory(paths.LogFolder);
        var config = new LoggerConfiguration()
            .MinimumLevel.Information()
            .MinimumLevel.Override("Microsoft", LogEventLevel.Warning)
            .MinimumLevel.Override("System.Net.Http", LogEventLevel.Warning)
            .Enrich.FromLogContext()
            .WriteTo.File(Path.Combine(paths.LogFolder, "agent-.log"), rollingInterval: RollingInterval.Day, retainedFileCountLimit: 14,
                fileSizeLimitBytes: 20 * 1024 * 1024, rollOnFileSizeLimit: true,
                outputTemplate: "{Timestamp:yyyy-MM-dd HH:mm:ss.fff zzz} [{Level:u3}] {Message:lj}{NewLine}{Exception}");
        if (interactive) config = config.WriteTo.Console(outputTemplate: "{Timestamp:HH:mm:ss} [{Level:u3}] {Message:lj}{NewLine}{Exception}");
        return config.CreateLogger();
    }
}

public static class Http
{
    /// <summary>
    /// One HttpClient for the agent's life. It uses the machine's proxy settings (many factories send outbound traffic through one), TLS from
    /// the operating system, and never follows redirects (a redirect would send a signed request somewhere it was not signed for).
    /// </summary>
    public static HttpClient Client() => new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
        PooledConnectionLifetime = TimeSpan.FromMinutes(10),
        ConnectTimeout = TimeSpan.FromSeconds(20),
        UseProxy = true,
        Proxy = HttpClient.DefaultProxy,
    })
    {
        Timeout = TimeSpan.FromSeconds(60),
    };
}

public static class AgentJobs
{
    /// <summary>The jobs this agent does, with its database adapters, its password store and the local allow-list.</summary>
    public static JobHandlers Create(AgentPaths paths, IKeyProtector protector, Func<System.Security.Cryptography.ECDiffieHellman> sealingKey) =>
        JobHandlers.ForDatabases(new Fortress.Agent.Adapters.DatabaseAdapters(), new CredentialStore(paths.CredentialsFolder, protector), paths.AllowListFile, sealingKey);
}

public static class AgentHost
{
    /// <summary>The agent as a long-running process: a Windows service when started by the service manager, else a console program.</summary>
    public static async Task<int> RunAsync(AgentPaths paths, IdentityStore store, string[] args)
    {
        var identity = store.Load();
        if (identity is null)
        {
            Log.Error("This agent is not registered. Run: FortressAgent register --api <address> --token <token>  (the token comes from Fortress, Settings → Integrations → Connector agents)");
            return 3;
        }
        var builder = Microsoft.Extensions.Hosting.Host.CreateApplicationBuilder(new HostApplicationBuilderSettings { Args = [], ContentRootPath = AppContext.BaseDirectory });
        builder.Services.AddWindowsService(o => o.ServiceName = "FortressConnectorAgent");
        builder.Logging.ClearProviders();
        builder.Services.AddSerilog();
        builder.Services.AddSingleton(identity);
        builder.Services.AddSingleton(_ => Http.Client());
        builder.Services.AddSingleton(sp => new AgentApiClient(sp.GetRequiredService<HttpClient>()));
        builder.Services.AddSingleton(_ => AgentJobs.Create(paths, KeyProtectors.ForThisMachine(), () => identity.SealingKey));
        builder.Services.AddSingleton(sp => new AgentRunner(
            sp.GetRequiredService<AgentIdentity>(), sp.GetRequiredService<AgentApiClient>(), sp.GetRequiredService<JobHandlers>(),
            sp.GetRequiredService<ILogger<AgentRunner>>()));
        builder.Services.AddHostedService<AgentWorker>();
        builder.Services.Configure<HostOptions>(o => o.ShutdownTimeout = TimeSpan.FromSeconds(30));
        using var host = builder.Build();
        await host.RunAsync();
        return Environment.ExitCode;
    }
}

/// <summary>
/// Runs the agent loop. When Fortress says the agent is revoked the service stops itself cleanly (exit code 0, so Windows does not restart it).
/// </summary>
public sealed class AgentWorker(AgentRunner runner, IHostApplicationLifetime lifetime, ILogger<AgentWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            var outcome = await runner.RunAsync(stoppingToken);
            if (outcome == RunOutcome.Revoked)
            {
                Environment.ExitCode = 0;
                lifetime.StopApplication();
            }
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogCritical(e, "The agent stopped on an unexpected error");
            Environment.ExitCode = 1;
            lifetime.StopApplication();
        }
    }
}
