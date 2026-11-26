/// <reference types="node" />
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultRoutingFile } from "../server/paths";
import type { Route, Routing } from "../shared/routing";
import type { Role } from "../shared/scopes";
import { resolveEffective } from "../shared/scopes";
import { applyRouting, parseRouting } from "../server/routing-file";
import { readScopesFile, revisionOf, roleView } from "../server/scopes-file";

// Agent CLI for routing. Same files and env overrides as the plugin; same resolver, view
// revision and file parser. Output is compact JSON; `resolve` never returns other sets.

export type Env = Record<string, string | undefined>;
export type Result = { code: number; out: Record<string, unknown> };

export function routingPath(env: Env): string {
  return env.PASEO_MODEL_ROUTING_FILE || defaultRoutingFile(env);
}

export function scopesPath(env: Env): string {
  return env.PASEO_MODEL_ROUTING_SCOPES_FILE || join(dirname(routingPath(env)), "model-routing-scopes.json");
}

/** `--flag value` pairs; unknown flags are kept so each command can reject them. */
function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Flag ${token} needs a value.`);
      flags[token.slice(2)] = value;
      index += 1;
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

const fail = (out: Record<string, unknown>): Result => ({ code: 1, out });

export async function resolveCommand(argv: string[], env: Env): Promise<Result> {
  const { flags } = parseArgs(argv);
  const role = flags.role as Role | undefined;
  if (role !== undefined && role !== "lead" && role !== "peer") return fail({ error: "usage", hint: "--role is lead or peer." });
  if (!flags.workspace && !flags.project) {
    return fail({
      error: "unresolved",
      hint: "Pass --workspace <id> or --project <id>. PASEO_WORKSPACE_ID is not read yet (daemon check not built).",
    });
  }
  const routingFile = await readFile(routingPath(env), "utf8");
  const routing = parseRouting(routingFile);
  const scopes = await readScopesFile(scopesPath(env));
  if (!scopes.scopes) return fail({ error: "config", hint: scopes.error ?? "Scopes file unreadable." });
  const workspaceId = flags.workspace ?? null;
  const projectId = flags.project ?? null;
  if (workspaceId && !scopes.scopes.workspaces[workspaceId] && !projectId) {
    // Without a workspace entry the project decides, and the project is not known here.
    return fail({ error: "unresolved", hint: `Workspace ${workspaceId} has no entry; also pass --project <id> so its project entry applies.` });
  }
  const effective = resolveEffective(scopes.scopes, routing, workspaceId, projectId);
  if (effective.error || !effective.set) return fail({ error: "config", hint: effective.error ?? "No set." });
  const target = workspaceId
    ? { kind: "workspace", id: workspaceId, via: "flag" }
    : { kind: "project", id: projectId, via: "flag" };
  const source = { kind: effective.scope.kind, id: effective.scope.id };
  const revisions = { routing: revisionOf(routingFile), scopes: scopes.revision };
  const views = (["lead", "peer"] as Role[]).map((name) => [name, roleView(routing, effective.set!, name)] as const);
  if (role) {
    const view = views.find(([name]) => name === role)![1];
    if (!view) return fail({ error: "no_rows", hint: `Set ${effective.set} has no ${role} rows.` });
    return {
      code: 0,
      out: {
        set: effective.set,
        source,
        enforced: effective.enforced,
        rev: view.revision,
        role,
        target,
        routes: view.routes.map(toRouteOut),
        revisions,
      },
    };
  }
  return {
    code: 0,
    out: {
      set: effective.set,
      source,
      enforced: effective.enforced,
      target,
      views: Object.fromEntries(
        views.map(([name, view]) => [name, view ? { rev: view.revision, routes: view.routes.map(toRouteOut) } : null]),
      ),
      revisions,
    },
  };
}

function toRouteOut(route: Route) {
  return { tier: route.tier, provider: route.provider, model: route.model, effort: route.effort, note: route.note };
}

/** Add or change one row of a set. Requires the routing file revision from a previous read. */
export async function setRouteCommand(argv: string[], env: Env): Promise<Result> {
  const { positional, flags } = parseArgs(argv);
  const [setName, tier] = positional;
  if (!setName || !tier || !flags.provider || !flags.model || !flags.effort || !flags["routing-rev"]) {
    return fail({
      error: "usage",
      hint: "routing set-route <set> <tier> --provider P --model M --effort E [--note N] --routing-rev R",
    });
  }
  const path = routingPath(env);
  const raw = await readFile(path, "utf8");
  const current = revisionOf(raw);
  if (current !== flags["routing-rev"]) {
    return fail({
      error: "stale",
      hint: "model-routing.md changed since you read it. Read resolve again and retry with its revisions.routing.",
      current_routing_rev: current,
    });
  }
  const routing: Routing = parseRouting(raw);
  const preset = routing.presets.find((candidate) => candidate.name === setName);
  if (!preset) return fail({ error: "unknown_set", hint: `No set ${setName}.` });
  const existing = preset.routes.findIndex((row) => row.tier === tier);
  const route: Route = {
    tier,
    provider: flags.provider,
    model: flags.model,
    effort: flags.effort,
    note: flags.note ?? (existing >= 0 ? preset.routes[existing].note : ""),
  };
  const routes = existing >= 0
    ? preset.routes.map((row, index) => (index === existing ? route : row))
    : [...preset.routes, route];
  const next: Routing = {
    ...routing,
    presets: routing.presets.map((candidate) => (candidate.name === setName ? { ...candidate, routes } : candidate)),
  };
  const text = applyRouting(raw, next);
  parseRouting(text); // never write a file the next read cannot parse
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
  return {
    code: 0,
    out: { ok: true, set: setName, tier, route: toRouteOut(route), routing_rev: revisionOf(text), previous_routing_rev: current },
  };
}

export async function run(argv: string[], env: Env): Promise<Result> {
  const [command, ...rest] = argv;
  try {
    if (command === "resolve") return await resolveCommand(rest, env);
    if (command === "set-route") return await setRouteCommand(rest, env);
    if (command === "sets" || command === "assign" || command === "unassign") {
      return fail({ error: "deferred", hint: `${command} is not built yet.` });
    }
    return fail({ error: "usage", hint: "routing resolve | routing set-route" });
  } catch (error) {
    return fail({ error: "failed", hint: error instanceof Error ? error.message : String(error) });
  }
}

export async function main(argv: string[]): Promise<number> {
  const result = await run(argv, process.env);
  process.stdout.write(JSON.stringify(result.out) + "\n");
  return result.code;
}
