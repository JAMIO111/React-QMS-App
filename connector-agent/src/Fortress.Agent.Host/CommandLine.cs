using Fortress.Agent.Core;

namespace Fortress.Agent.Host;

/// <summary>The agent's few commands, parsed by hand (no package for four commands).</summary>
public sealed record CommandLine(string Command, string? Api, string? Token, string? DataDir, bool Replace, bool Force, string? Error, string? InstallDir = null, string? Service = null)
{
    public const string Help = """
        Fortress Connector Agent

          FortressAgent register --api <address> --token <FAGT-…> [--replace]
              Make this agent's keys and register it with Fortress. The address and the one-time token are shown in Fortress
              (Settings → Integrations → Connector agents → Add a connector agent). --replace registers afresh over an existing identity.
          FortressAgent run          Run the agent (what the Windows service does).
          FortressAgent status       Show what this machine is registered as.
          FortressAgent deregister [--force]
              Tell Fortress to revoke this agent and forget it here (used when uninstalling). --force forgets it even if Fortress cannot be told.
          FortressAgent apply-update --install <folder> [--service <name>]
              Windows: swap in the staged update. Normally run by the updater service (SYSTEM, its own copy of the program), which the agent
              starts once an approved update is staged. Checks the signed release again, stops the service, keeps the old folder, starts the
              new one and puts the old one back if it does not start or check in within 5 minutes. Exit 0 applied, 4 rolled back, 5 refused.

          --data-dir <folder>        Where the identity and logs are kept.
        """;

    private static readonly string[] Commands = ["register", "run", "status", "deregister", "apply-update", "help"];

    public static CommandLine Parse(string[] args)
    {
        string command = "run";
        string? api = null, token = null, dataDir = null, installDir = null, service = null;
        bool replace = false, force = false;
        var rest = new Queue<string>(args);
        if (rest.Count > 0 && !rest.Peek().StartsWith('-')) command = rest.Dequeue().ToLowerInvariant();
        if (command is "--help" or "-h" or "/?") command = "help";
        if (!Commands.Contains(command)) return Fail(command, $"Unknown command \"{command}\".");
        while (rest.Count > 0)
        {
            var arg = rest.Dequeue();
            string? Value() => rest.Count > 0 ? rest.Dequeue() : null;
            switch (arg)
            {
                case "--api": api = Value(); break;
                case "--token": token = Value(); break;
                case "--data-dir": dataDir = Value(); break;
                case "--replace": replace = true; break;
                case "--force": force = true; break;
                case "--install": installDir = Value(); break;
                case "--service": service = Value(); break;
                case "--help" or "-h": command = "help"; break;
                default: return Fail(command, $"Unknown option \"{arg}\".");
            }
        }
        if (command == "register")
        {
            if (AgentRegistration.ApiUrlProblem(api) is { } a) return Fail(command, a);
            if (AgentRegistration.TokenProblem(token) is { } t) return Fail(command, t);
        }
        if (command == "apply-update" && string.IsNullOrWhiteSpace(installDir)) return Fail(command, "apply-update needs --install <folder>.");
        return new CommandLine(command, api, token, dataDir, replace, force, null, installDir, service);
    }

    private static CommandLine Fail(string command, string error) => new(command, null, null, null, false, false, error);
}
