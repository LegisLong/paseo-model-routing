# Model routing

Model routing keeps a table of which provider, model and effort to use for each kind of work, and lets you assign a table to a workspace or a project. Agents that create other agents read the table instead of guessing. The plugin can also refuse an agent creation that was made from an outdated copy of the table.

## How it works

A routing file named `model-routing.md` holds named sets. Each set has a table of tiers (for example `routine` or `review`), and each row gives a provider, model, effort and note. One line, `active:`, names the global default set.

A second file, `model-routing-scopes.json`, assigns a set to a workspace or a project. A workspace entry wins over its project, and a project entry wins over the global default.

A Model routing screen in the sidebar edits both files. Model and effort choices come from the providers your daemon reports. A save is refused if the file changed on disk after the screen loaded it, so edits made by hand or by another client are not overwritten.

## The guard

The guard is off until you turn on `enforce` for a workspace or a project on the screen. In such a scope, a Supervisor creating a Lead, or a Lead creating a Peer, must pass the current `routing-rev` label for the role's rows. Otherwise the creation is refused, and the refusal lists the current rows and the label to add.

You declare which agents are Supervisors and Leads with role rules, in the Agent roles panel of the screen. A rule matches the creating agent by provider id (exact, or with `*` wildcards) and/or by labels that must all be present, and gives it the role `supervisor` or `lead`. The first matching rule wins, and an agent that matches none has no role, so the guard lets its creations through. For example, a rule for provider `claude` with the label `team-role=lead` makes only the Claude agents you labelled that way Leads. Labels are set with `paseo run --label` when an agent is created, or with `paseo agent update --label` later.

Without any rules the plugin applies two defaults: a provider id ending in `-supervisor` is a Supervisor and one ending in `-lead` is a Lead. If you name your providers that way you need to configure nothing. Choosing "Customize" copies these two rules into the file for editing, and from then on only your rules apply.

The guard checks that the creator read the current table. It does not check which model was chosen, so it is a freshness check and not a policy. It lets a creation through when anything inside the guard fails or takes longer than 3 seconds. Resumes, reopens and creations without a parent are never refused. Global enforcement is not available in this version.

## Setup

1. Open Model routing in the sidebar. On a daemon with no routing file, the screen shows the path it looks for and a button that creates a starting file with one set and one tier. It never overwrites an existing file.
2. Choose providers and models for the tiers, then save. Model and effort choices follow the catalogue each provider reports.
3. Optionally assign sets to workspaces or projects, declare which agents are Supervisors and Leads in the Agent roles panel (or rely on the default suffix rules), and turn on `enforce` where you want the guard.

Requires Paseo 0.16.2 or later. This release was run on Paseo 0.17.4. Versions before 0.2.0 cannot read a scopes file that has role rules.

## Files and access

- Reads and writes `model-routing.md` and `model-routing-scopes.json` in the daemon's Paseo home. Set `PASEO_MODEL_ROUTING_FILE` and `PASEO_MODEL_ROUTING_SCOPES_FILE` in the daemon's environment to use other paths. No other files are read or written.
- Reads the daemon's provider list, projects, workspaces and agent records through the Paseo SDK.
- Sends nothing over the network and downloads nothing. The routing tables stay in the two files on the daemon host.
- Runs as trusted, unsandboxed code in a daemon subprocess, like every Paseo plugin.
- Hooks agent creation and agent open requests. It adds one marker key to the metadata saved on each new agent so it can tell fresh creations from reopens. It does not change models, prompts or tools.
