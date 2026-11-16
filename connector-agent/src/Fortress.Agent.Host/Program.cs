// Fortress Connector Agent (docs/connector-agent-plan.md). One executable:
//   FortressAgent register --api <address> --token <FAGT-…> [--replace]   first run: make the keys, register with Fortress, keep the identity
//   FortressAgent run                                                    the agent itself (what the Windows service runs; the default)
//   FortressAgent status                                                 what this machine is registered as
//   FortressAgent deregister                                             tell Fortress to revoke this agent, then forget the identity (uninstall)
//   FortressAgent apply-update --install <folder> [--service <name>]     Windows: swap in a staged update, rolling back if it does not come up (AG6b)
// Common: --data-dir <folder> (default %ProgramData%\Fortress\ConnectorAgent on Windows, else $FORTRESS_AGENT_HOME or ~/.fortress-agent).
using Fortress.Agent.Core;
using Microsoft.Extensions.DependencyInjection;
using Fortress.Agent.Host;
using Serilog;

var cli = CommandLine.Parse(args);
if (cli.Error is { } usage)
{
    Console.Error.WriteLine(usage);
    Console.Error.WriteLine(CommandLine.Help);
    return 2;
}
if (cli.Command == "help")
{
    Console.WriteLine(CommandLine.Help);
    return 0;
}

var paths = AgentPaths.From(cli.DataDir);
Log.Logger = Logging.Create(paths, interactive: cli.Command != "run" || Environment.UserInteractive, cli.Command == "apply-update" ? "updater-.log" : "agent-.log");
try
{
    var store = new IdentityStore(paths.IdentityFile, KeyProtectors.ForThisMachine());
    using var http = Http.Client();
    var api = new AgentApiClient(http);
    // At registration there is no sealing key yet; the handlers are only asked what this agent can do.
    var handlers = AgentJobs.Create(paths, KeyProtectors.ForThisMachine(), null);
    using var stop = new CancellationTokenSource();
    Console.CancelKeyPress += (_, e) => { e.Cancel = true; stop.Cancel(); };

    switch (cli.Command)
    {
        case "register":
        {
            using var identity = await AgentRegistration.RegisterAsync(api, store, cli.Api!, cli.Token!, handlers, cli.Replace, null, stop.Token);
            Console.WriteLine($"Registered as \"{identity.Name}\" for {identity.OrganisationName}.");
            Console.WriteLine($"Agent id: {identity.AgentId}");
            Console.WriteLine($"Key fingerprint: {identity.Fingerprint} (Fortress shows the same on the agent's page)");
            Console.WriteLine($"Identity kept in {store.Path}");
            return 0;
        }
        case "status":
        {
            using var identity = store.Load();
            if (identity is null)
            {
                Console.WriteLine($"Not registered (no identity in {store.Path}).");
                return 1;
            }
            Console.WriteLine($"Agent \"{identity.Name}\" ({identity.AgentId}) for {identity.OrganisationName}");
            Console.WriteLine($"Fortress: {identity.ApiUrl}");
            Console.WriteLine($"Registered: {identity.RegisteredAt:u}");
            Console.WriteLine($"Key fingerprint: {identity.Fingerprint}");
            Console.WriteLine($"Agent version: {AgentInfo.Version}");
            return 0;
        }
        case "deregister":
        {
            using var identity = store.Load();
            if (identity is null)
            {
                Console.WriteLine("Not registered; nothing to do.");
                return 0;
            }
            try
            {
                await api.DeregisterAsync(identity, stop.Token);
                Console.WriteLine("Fortress has revoked this agent.");
            }
            catch (AgentApiException e) when (e.Revoked)
            {
                Console.WriteLine("Fortress had already revoked this agent.");
            }
            catch (Exception e) when (e is AgentApiException or AgentNetworkException && !cli.Force)
            {
                Console.Error.WriteLine($"Fortress could not be told ({e.Message}). Nothing was removed. Revoke the agent in Fortress, or run again with --force to forget it here anyway.");
                return 1;
            }
            store.Delete();
            if (Directory.Exists(paths.CredentialsFolder)) Directory.Delete(paths.CredentialsFolder, recursive: true);
            Console.WriteLine($"Identity and database passwords removed from {paths.Root}.");
            return 0;
        }
        case "apply-update":
        {
            if (!OperatingSystem.IsWindows())
            {
                Console.Error.WriteLine("apply-update swaps a Windows service; on this platform install the staged update by hand.");
                return 2;
            }
            var updaterLog = new Serilog.Extensions.Logging.SerilogLoggerFactory(Log.Logger).CreateLogger("Updater");
            var swapper = UpdaterRun.Create(paths, cli.InstallDir!, cli.Service ?? AgentPaths.ServiceName, updaterLog);
            if (Microsoft.Extensions.Hosting.WindowsServices.WindowsServiceHelpers.IsWindowsService())
            {
                // Started by the service manager as the updater service (the normal way): run once as a service, then stop.
                var builder = Microsoft.Extensions.Hosting.Host.CreateApplicationBuilder();
                builder.Services.AddWindowsService(o => o.ServiceName = AgentPaths.UpdaterServiceName);
                builder.Services.AddSerilog();
                builder.Services.AddSingleton(swapper);
                builder.Services.AddHostedService<UpdaterWorker>();
                using var host = builder.Build();
                await host.RunAsync();
                return Environment.ExitCode;
            }
            // Run by an administrator from a command prompt (a manual swap, or the Windows checks in CI).
            return UpdaterRun.ExitCode(await swapper.ApplyAsync(stop.Token));
        }
        default:
            return await AgentHost.RunAsync(paths, store, args);
    }
}
catch (ArgumentException e)
{
    Log.Error("{Message}", e.Message);
    return 2;
}
catch (InvalidOperationException e)
{
    Log.Error("{Message}", e.Message);
    return 1;
}
catch (AgentApiException e)
{
    Log.Error("Fortress refused: {Message} ({Code})", e.Message, e.Code);
    return 1;
}
catch (AgentNetworkException e)
{
    Log.Error("{Message}", e.Message);
    return 1;
}
finally
{
    await Log.CloseAndFlushAsync();
}
