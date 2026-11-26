# Model routing

Model routing keeps a table of which provider, model and effort to use for each kind of work, and lets you assign a table to a workspace or a project. Agents that create other agents read the table instead of guessing. The plugin can also refuse an agent creation that was made from an outdated copy of the table.

## How it works

A routing file named `model-routing.md` holds named sets. Each set has a table of tiers (for example `routine` or `review`), and each row gives a provider, model, effort and note. One line, `active:`, names the global default set.

A second file, `model-routing-scopes.json`, assigns a set to a workspace or a project. A workspace entry wins over its project, and a project entry wins over the global default.

A Model routing screen in the sidebar edits both files. Model and effort choices come from the providers your daemon reports. A save is refused if the file changed on disk after the screen loaded it, so edits made by hand or by another client are not overwritten.

## The guard

The guard is off until you turn on `enforce` for a workspace or a project on the screen. In such a scope, a Supervisor creating a Lead, or a Lead creating a Peer, must pass the current `routing-rev` label for the role's rows. Otherwise the creation is refused, and the refusal lists the current rows and the label to add.

Roles come from a naming convention. The guard takes the role from the provider id of the creating agent: an id ending in `-supervisor` is a Supervisor, and one ending in `-lead` is a Lead. Any other provider id, such as plain `claude` or `codex`, has no role, and the guard lets its creations through. The guard therefore has an effect only if you name your providers with these suffixes, for example custom providers `claude-supervisor` and `claude-lead`. Without them the plugin is a routing table editor and a screen for assigning sets to workspaces and projects.

The guard checks that the creator read the current table. It does not check which model was chosen, so it is a freshness check and not a policy. It lets a creation through when anything inside the guard fails or takes longer than 3 seconds. Resumes, reopens and creations without a parent are never refused. Global enforcement is not available in this version.

## Setup

1. Open Model routing in the sidebar. On a daemon with no routing file, the screen shows the path it looks for and a button that creates a starting file with one set and one tier. It never overwrites an existing file.
2. Choose providers and models for the tiers, then save. Model and effort choices follow the catalogue each provider reports.
3. Optionally assign sets to workspaces or projects and turn on `enforce` where you want the guard, if your providers follow the naming above.

Requires Paseo 0.16.2 or later. This release was run on Paseo 0.17.4.

## Files and access

- Reads and writes `model-routing.md` and `model-routing-scopes.json` in the daemon's Paseo home. Set `PASEO_MODEL_ROUTING_FILE` and `PASEO_MODEL_ROUTING_SCOPES_FILE` in the daemon's environment to use other paths. No other files are read or written.
- Reads the daemon's provider list, projects, workspaces and agent records through the Paseo SDK.
- Sends nothing over the network and downloads nothing. The routing tables stay in the two files on the daemon host.
- Runs as trusted, unsandboxed code in a daemon subprocess, like every Paseo plugin.
- Hooks agent creation and agent open requests. It adds one marker key to the metadata saved on each new agent so it can tell fresh creations from reopens. It does not change models, prompts or tools.
