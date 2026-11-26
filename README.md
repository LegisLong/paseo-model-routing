# Model routing for Paseo

A Paseo plugin that keeps a table of provider, model and effort choices per tier
("set"), assigns sets to workspaces and projects, and can refuse agent creations that
were made from an outdated table.

![Model routing screen, showing demo data](docs/model-routing.png)

*Demo data.*

## What it does

- **Sets.** `model-routing.md` holds named sets. Each set has one table of tiers (for example
  `routine`), and each row gives a provider, model, effort and note. The `active:` line names the
  global default set.
- **Assignments.** `model-routing-scopes.json` (beside the routing file) assigns a set to a
  workspace or project. A workspace entry wins over its project, and a project wins over the
  global default.
- **Screen.** A "Model routing" screen in the Paseo sidebar edits sets and assignments.
  A save is refused when the file changed since it was loaded. See [First run](#first-run).
- **Guard.** In a scope where an assignment has `enforce: true`, a Supervisor creating a Lead,
  or a Lead creating a Peer, must pass the current `routing-rev` label for the role's rows.
  Otherwise the creation is refused with the current rows and the label to add. Which agents count as
  Supervisor or Lead is set by [role rules](#agent-roles-who-the-guard-applies-to).
- **CLI.** `bin/routing.mjs` prints the effective set for a workspace or project, and edits one
  row with a revision check. It is for source checkouts only (see below).

## Requirements

- Paseo `>=0.16.2` (see `paseo-plugin.json`). This release was run on Paseo 0.17.4. 0.16.2 is the oldest version an
  earlier build was run on; it is untested with this release.
- Node.js with TypeScript type stripping, for the CLI and the tests only (tested on Node 26). The plugin
  itself needs no Node setup beyond the daemon's.
- The plugin has no runtime dependencies of its own: `@getpaseo/plugin`, `zod`, `react`, `react-native`
  and `@tanstack/react-query` come from Paseo, so installing it runs no build step.

## Install

From Git, pinned to a release tag:

```
paseo plugin add git:Meron-Labs/paseo-model-routing --ref v0.2.0
paseo plugin ls
```

`plugin ls` should show `model-routing` as `running` with no error. Add `--home <daemon home>` to
both commands for a daemon that does not use `~/.paseo`. If the daemon already has a `model-routing`
entry, install fails with `Plugin ID "model-routing" is already configured`; remove it first with
`paseo plugin remove model-routing`.

Installing a plugin runs its code unsandboxed on the daemon host. Install only code you have read.

For development, install from a checkout instead:

```
npm ci
paseo plugin install /absolute/path/to/model-routing --id model-routing --home <daemon home>
paseo plugin reload model-routing --home <daemon home>
paseo plugin ls --home <daemon home>
```

Here `plugin ls` shows the checkout path as the source.

Rollback: `paseo plugin remove model-routing`. Before any change to a daemon that
already has routing files, copy `model-routing.md` and `model-routing-scopes.json` (if present) to a
timestamped backup, and restore from that backup on rollback. Do not delete the scopes file.

## First run

A new install has no `model-routing.md`. Open "Model routing" in the sidebar: the screen shows the
path it looks for and a "Create starting file" button. It writes a file with one set, `default`, and
one tier, `routine`, that names no provider yet. Pick providers and models on the screen and save.
The button never overwrites an existing file.

To start from your own file instead, put a `model-routing.md` at that path, for example a copy of
[`examples/model-routing.md`](examples/model-routing.md), and reload the screen. The example names
placeholder providers (`example-peer`); change them to providers your daemon has. A set that names a
provider the daemon does not list is kept as written.

## Files and environment

By default both files live in the daemon's Paseo home: `PASEO_HOME` (which the daemon sets from
`--home` for its plugins and agents), else `~/.paseo`.

| Variable | Purpose | Default |
| --- | --- | --- |
| `PASEO_MODEL_ROUTING_FILE` | Routing file (sets and `active:`) | `model-routing.md` in the Paseo home |
| `PASEO_MODEL_ROUTING_SCOPES_FILE` | Assignments file | `model-routing-scopes.json` beside the routing file |

The two variables win over the Paseo home. Set them in the environment of the daemon that loads the
plugin. Other paths are not read. A missing scopes file means no assignments and nothing enforced.
The CLI uses the same rule, so an agent started by the daemon finds the daemon's files without any
variable.

## Agent CLI (source checkout only)

The CLI reads and writes the same files as the plugin. It is not installed by the plugin and is not
published as a package. Run it from the checkout.

```
node bin/routing.mjs resolve --workspace <workspace-id> [--project <project-id>] [--role lead|peer]
node bin/routing.mjs set-route <set> <tier> --provider P --model M --effort E [--note N] --routing-rev R
```

- Pass `--workspace` or `--project` explicitly. The CLI does not read `PASEO_WORKSPACE_ID` and does not
  look up the daemon, so it never guesses a target from the working directory. Without a target the
  result is `{"error":"unresolved"}` and the exit code is 1. A workspace with no entry also needs
  `--project`, so the project's entry applies.
- `resolve` prints one effective set, its source, whether it is enforced, the role revision, and the routes.
  It never prints other sets or other scopes.
- `set-route` needs the routing-file revision from a previous `resolve` (`revisions.routing`). A stale
  revision is refused and nothing is written.
- The CLI does not check models against the providers the daemon reports. The plugin's screen and save do.

Example, using the example files in `examples/` (run from another directory, with the env variables set):

```
PASEO_MODEL_ROUTING_FILE=/path/to/model-routing/examples/model-routing.md
PASEO_MODEL_ROUTING_SCOPES_FILE=/path/to/model-routing/examples/model-routing-scopes.json
node /path/to/model-routing/bin/routing.mjs resolve --workspace ws-example --project prj-example --role peer
```

Output (formatted for reading; the CLI prints one line; revisions are shortened with `…`, and they are
hashes of the file bytes, so a checkout that converts line endings to CRLF prints other values):

```
{"set":"fast","source":{"kind":"workspace","id":"ws-example"},"enforced":true,"rev":"e9bbd91d6885","role":"peer",
 "target":{"kind":"workspace","id":"ws-example","via":"flag"},
 "routes":[{"tier":"routine","provider":"example-peer","model":"model-small","effort":"low","note":""},
           {"tier":"review","provider":"","model":"","effort":"","note":"two models of different families"}],
 "revisions":{"routing":"1a3719cd01c2…","scopes":"0c86ae927bb8…"}}
```

A refused edit:

```
node /path/to/model-routing/bin/routing.mjs set-route fast routine --provider example-peer --model model-small --effort low --routing-rev 0000
{"error":"stale","hint":"model-routing.md changed since you read it. Read resolve again and retry with its revisions.routing.","current_routing_rev":"1a3719cd01c2…"}
```

The `rev` from `resolve --role` is the value a creation must carry in its `routing-rev` label.

Not built yet: duplicating or assigning sets from the CLI, unassigning, listing all sets, and reading
the workspace from `PASEO_WORKSPACE_ID`. Use the screen for these.

### Caller and target

A caller's workspace is not the target of a creation. A Lead running in workspace A can create a child
in workspace B. The guard checks the child's actual workspace when the creation happens, and the CLI
targets only the workspace or project you pass. Nothing in either path forces a model: the guard checks
the revision label, and the child's model is whatever the creator requested.

## Agent roles (who the guard applies to)

The guard needs to know which creating agent is a Supervisor (creates Leads) and which is a Lead
(creates Peers). You declare that with `roles` in `model-routing-scopes.json`, or edit the same list
in the "Agent roles" panel of the screen. Each rule gives a `match` and a `role`. Rules are checked
in order and the first match wins. An agent that matches no rule has no role, and its creations are
always allowed.

```json
"roles": [
  { "match": { "provider": "*-supervisor" }, "role": "supervisor" },
  { "match": { "provider": "claude", "labels": { "team-role": "lead" } }, "role": "lead" }
]
```

- `role` is the role of the agent that creates: `supervisor` creates Leads (it gets the rows of the
  `lead` tier), `lead` creates Peers (it gets all other rows).
- `match.provider` is the provider id of the creating agent. It matches exactly, or with `*` as a
  wildcard for any run of characters (`*-lead`). Matching is case-sensitive and anchored.
- `match.labels` is a set of `key: value` pairs that must all be on the creating agent.
- When a rule has both, both must match. A `match` with neither is refused on save.
- **Without `roles`** the default rules apply: `*-supervisor` is a Supervisor and `*-lead` is a Lead,
  the naming convention of 0.1.0. Existing setups keep working with no change. With `roles` present,
  even as `[]`, only your rules apply, and `[]` means no agent has a role.

Labels are set when an agent is created or later, with Paseo's own tools:

```
paseo run --label team-role=lead "<task>"
paseo agent update <agent-id> --label team-role=lead
```

An agent can do the same through the `update_agent` tool. The label has to be on the creating agent
when it creates a child, so set it before the agent starts its work.

The refusal message names the rule that gave the creator its role, for example
`Creator role: Lead by rule 2 of roles (provider claude, labels team-role=lead)`.

Versions before 0.2.0 do not know `roles`. They read a scopes file that has it as invalid: the screen
refuses to edit assignments and the guard allows every creation. Remove `roles` or restore a backup of
the file before going back to such a version.

## The guard: behavior and limits

- **Roles come from your rules** (see above). Without rules, the guard has an effect only if you
  name providers with the `-supervisor` and `-lead` suffixes. Otherwise the plugin is a table
  editor and a scope assignment screen, and `enforce` has no effect.
- It checks one thing: that the creator's `routing-rev` label equals the revision of the role's rows
  in the effective set for the child's workspace. It does not check which model was chosen.
- It refuses only fresh, interactive creations with a parent in an enforced scope. Other paths
  (resume, reopen, creations without a parent, unenforced scopes) are allowed.
- It fails open: any internal error or a timeout of 3 seconds lets the creation through.
- The refusal text names the scope, the set, the revision and the rows, and says that nothing was created.
- It is a freshness check, not a policy: a creator that reads a current table can still choose any model.
- Global enforcement is refused in this version. Enforce per workspace or per project.

## Development

```
npm ci
npm run typecheck
npm test
```

The tests use temporary files and fake daemon data. They do not need a running daemon.

## License

MIT. See `LICENSE`.

The plugin is built against the [Paseo](https://github.com/getpaseo/paseo) plugin SDK
(`@getpaseo/plugin`, Apache-2.0), which is a development dependency only. No SDK code is copied
into this repository; Paseo supplies the SDK at runtime.
