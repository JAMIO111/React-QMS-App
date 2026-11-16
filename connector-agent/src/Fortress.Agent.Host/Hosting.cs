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
    /// <summary>The service's name in the Windows service manager.</summary>
    public const string ServiceName = "FortressConnectorAgent";
    /// <summary>
    /// The updater (AG6b, AG6d review): a second service running as SYSTEM from its own copy of the program (Program Files\Fortress\ConnectorAgentUpdater),
    /// started on demand. The agent's account may start it and nothing else; it checks the staged release again itself before it swaps.
    /// </summary>
    public const string UpdaterServiceName = "FortressConnectorAgentUpdater";

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
    public static Serilog.ILogger Create(AgentPaths paths, bool interactive, string file = "agent-.log")
    {
        Directory.CreateDirectory(paths.LogFolder);
        var config = new LoggerConfiguration()
            .MinimumLevel.Information()
            .MinimumLevel.Override("Microsoft", LogEventLevel.Warning)
            .MinimumLevel.Override("System.Net.Http", LogEventLevel.Warning)
            .Enrich.FromLogContext()
            .WriteTo.File(Path.Combine(paths.LogFolder, file), rollingInterval: RollingInterval.Day, retainedFileCountLimit: 14,
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

    private static HttpClient? downloads;

    /// <summary>
    /// For release downloads only (AG6b): follows redirects (releases are often served through a storage service's redirect), at most five, and
    /// the update handler refuses a download that ended anywhere but https. Integrity comes from the signed manifest's SHA-256, not the address.
    /// </summary>
    public static HttpClient Downloads() => downloads ??= new HttpClient(new SocketsHttpHandler
    {
        AllowAutoRedirect = true,
        MaxAutomaticRedirections = 5,
        ConnectTimeout = TimeSpan.FromSeconds(20),
        UseProxy = true,
        Proxy = HttpClient.DefaultProxy,
    })
    {
        Timeout = TimeSpan.FromMinutes(20),
    };
}

public static class AgentJobs
{
    /// <summary>
    /// The jobs this agent does, with its database adapters, its password store and the local allow-list, plus key rotation and diagnostics (AG6a).
    /// </summary>
    public static JobHandlers Create(AgentPaths paths, IKeyProtector protector, AgentIdentity? identity)
    {
        JobHandlers? handlers = null;
        var diagnostics = new DiagnosticsHandler(paths.LogFolder, paths.AllowListFile, () => identity, () => handlers!.Capabilities());
        var update = new UpdateHandler(paths.Root, () => Http.Downloads(), new Serilog.Extensions.Logging.SerilogLoggerFactory(Log.Logger).CreateLogger("Updates"));
        handlers = JobHandlers.ForDatabasesWithKeys(new Fortress.Agent.Adapters.DatabaseAdapters(), new CredentialStore(paths.CredentialsFolder, protector), paths.AllowListFile,
            () => identity?.SealingKeys(DateTimeOffset.UtcNow) ?? throw new InvalidOperationException("Not registered"), new RotateKeysHandler(), diagnostics, update);
        return handlers;
    }
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
        builder.Services.AddSingleton(_ => AgentJobs.Create(paths, KeyProtectors.ForThisMachine(), identity));
        builder.Services.AddSingleton(sp => new AgentRunner(
            sp.GetRequiredService<AgentIdentity>(), sp.GetRequiredService<AgentApiClient>(), sp.GetRequiredService<JobHandlers>(),
            sp.GetRequiredService<ILogger<AgentRunner>>(), rotation: new KeyRotation(store, sp.GetRequiredService<ILogger<AgentRunner>>()),
            updates: new UpdateState(paths.Root, sp.GetRequiredService<ILogger<AgentRunner>>()),
            afterComplete: (job, ct) => job.Kind == "update_agent" ? Updater.StartSwap(paths, sp.GetRequiredService<ILogger<AgentRunner>>()) : Task.CompletedTask));
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

/// <summary>
/// Starting the swap once an update is staged (AG6b). On Windows the agent asks the service manager to start the updater service, which runs as
/// SYSTEM from its own copy of the program: the agent's own account can neither stop its service nor write Program Files, and must not be able to
/// (AG6d review). The updater trusts nothing the agent staged: it checks the signed release again (<see cref="UpdatePreparer"/>). Elsewhere the update
/// stays staged and the log says where it is; it is installed by hand.
/// </summary>
public static class Updater
{
    public static Task StartSwap(AgentPaths paths, Microsoft.Extensions.Logging.ILogger logger)
    {
        var pending = new UpdateFiles(paths.Root).ReadPending();
        if (pending is null) return Task.CompletedTask;
        if (!OperatingSystem.IsWindows())
        {
            logger.LogWarning("Update to {Version} is staged in {Folder}; this platform does not swap it in by itself: install it by hand", pending.Version, pending.Staged);
            return Task.CompletedTask;
        }
        try
        {
            using var updater = new System.ServiceProcess.ServiceController(AgentPaths.UpdaterServiceName);
            updater.Start();
            logger.LogInformation("Update to {Version} staged; the updater service has started and will restart this service", pending.Version);
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            logger.LogWarning("Update to {Version} is staged, but the updater service could not be started ({Message}). Reinstall the agent with the current installer, which adds it.",
                pending.Version, e.Message);
        }
        return Task.CompletedTask;
    }
}

/// <summary>The updater as a Windows service: it swaps once, then stops (the exit code says applied 0, rolled back 4, refused 5).</summary>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class UpdaterWorker(UpdateSwapper swapper, IHostApplicationLifetime lifetime, ILogger<UpdaterWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            Environment.ExitCode = UpdaterRun.ExitCode(await swapper.ApplyAsync(stoppingToken));
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogError(e, "The update could not be applied");
            Environment.ExitCode = 1;
        }
        finally
        {
            lifetime.StopApplication();
        }
    }
}

public static class UpdaterRun
{
    public static int ExitCode(string outcome) => outcome switch { "applied" => 0, "rolled_back" => 4, "refused" => 5, _ => 1 };

    /// <summary>The swapper the updater uses: the signed release checked again with this program's own built-in keys, unpacked beside the install folder.</summary>
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    public static UpdateSwapper Create(AgentPaths paths, string installDir, string service, Microsoft.Extensions.Logging.ILogger logger)
    {
        var install = Path.GetFullPath(installDir).TrimEnd(Path.DirectorySeparatorChar);
        var installed = InstalledVersion(install) ?? AgentInfo.Version;
        return new UpdateSwapper(paths.Root, install, new WindowsServiceControl(service), logger,
            prepare: pending => UpdatePreparer.Prepare(pending, install + ".staging", ReleaseKeys.Trusted(), AgentInfo.Platform, installed));
    }

    /// <summary>The version of the agent in the install folder (the updater is a separate copy and may be older or newer).</summary>
    public static string? InstalledVersion(string install)
    {
        var exe = Path.Combine(install, "FortressAgent.exe");
        if (!File.Exists(exe)) return null;
        var v = System.Diagnostics.FileVersionInfo.GetVersionInfo(exe);
        return v.FileMajorPart + v.FileMinorPart + v.FileBuildPart == 0 && v.FileVersion is null ? null : $"{v.FileMajorPart}.{v.FileMinorPart}.{v.FileBuildPart}";
    }
}

/// <summary>The Windows service manager, for the updater.</summary>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class WindowsServiceControl(string name) : IServiceControl
{
    public async Task StopAsync(CancellationToken ct)
    {
        using var sc = new System.ServiceProcess.ServiceController(name);
        if (sc.Status != System.ServiceProcess.ServiceControllerStatus.Stopped)
        {
            if (sc.Status != System.ServiceProcess.ServiceControllerStatus.StopPending) sc.Stop();
            await Task.Run(() => sc.WaitForStatus(System.ServiceProcess.ServiceControllerStatus.Stopped, TimeSpan.FromMinutes(2)), ct);
        }
    }

    public async Task StartAsync(CancellationToken ct)
    {
        using var sc = new System.ServiceProcess.ServiceController(name);
        if (sc.Status != System.ServiceProcess.ServiceControllerStatus.Running)
        {
            sc.Start();
            await Task.Run(() => sc.WaitForStatus(System.ServiceProcess.ServiceControllerStatus.Running, TimeSpan.FromMinutes(2)), ct);
        }
    }
}
