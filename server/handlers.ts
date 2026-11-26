/// <reference types="node" />
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { ProviderOption, Routing, RoutingState } from "../shared/routing";
import { MISSING_ROUTING_REVISION, NO_PROVIDER } from "../shared/routing";
import type { ResolveOutput, Scopes, ScopesState, SetOp } from "../shared/scopes";
import { defaultRoutingFile } from "./paths";
import { applyRouting, parseRouting, starterRouting } from "./routing-file";
import { readScopesFile, resolveEffective, revisionOf, roleView, writeScopesFile } from "./scopes-file";
import { applySetOp, assertNoReferencedRemoval } from "./sets";

// Routing file the guard and the screen read. Defaults to the daemon's Paseo home (PASEO_HOME, else
// ~/.paseo); override with the env var.
export const ROUTING_FILE = process.env.PASEO_MODEL_ROUTING_FILE || defaultRoutingFile(process.env);

// Scope assignments, beside the routing file unless overridden.
export const SCOPES_FILE =
  process.env.PASEO_MODEL_ROUTING_SCOPES_FILE || join(dirname(ROUTING_FILE), "model-routing-scopes.json");

// One writer at a time inside this process for both files.
let writeQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

type Thinking = { id: string; label: string };
type SnapshotModel = {
  id: string;
  label: string;
  isSelectable?: boolean;
  thinkingOptions?: Thinking[];
  thinkingSet?: number;
};
type SnapshotEntry = {
  provider: string;
  label?: string;
  enabled?: boolean;
  status?: string;
  models?: SnapshotModel[];
};

/** How long a read waits for the daemon's lazy provider discovery before answering with what it has. */
const PROVIDER_WAIT_MS = 5000;

/**
 * The daemon lists every provider as `loading`, without models, until its discovery finishes
 * (Some providers start a CLI first). Wait briefly for it; the screen polls while any is still loading.
 */
async function providerSnapshot(context: PluginHandlerContext) {
  try {
    return await context.paseo.providers.waitForReady({ timeoutMs: PROVIDER_WAIT_MS });
  } catch {
    return context.paseo.providers.snapshot();
  }
}

export function modelsStatus(entry: Pick<SnapshotEntry, "enabled" | "status">, modelCount: number) {
  if (modelCount > 0 || entry.status === "ready") return "ready" as const;
  if (entry.enabled !== false && (entry.status === undefined || entry.status === "loading")) return "loading" as const;
  return "unavailable" as const;
}

async function listProviders(context: PluginHandlerContext): Promise<ProviderOption[]> {
  const snapshot = await providerSnapshot(context);
  const thinkingSets = snapshot.compactSnapshot?.thinkingSets ?? [];
  const compact = new Map<string, SnapshotEntry>(
    (snapshot.compactSnapshot?.entries ?? []).map((entry) => [entry.provider, entry as SnapshotEntry]),
  );
  return (snapshot.entries as SnapshotEntry[])
    .map((entry) => {
      const models = entry.models ?? compact.get(entry.provider)?.models ?? [];
      const status = entry.status ?? compact.get(entry.provider)?.status;
      return {
        id: entry.provider,
        label: entry.label ?? entry.provider,
        enabled: entry.enabled !== false,
        modelsStatus: modelsStatus({ enabled: entry.enabled, status }, models.length),
        models: models
          .filter((model) => model.isSelectable !== false)
          .map((model) => ({
            id: model.id,
            label: model.label,
            efforts: (
              model.thinkingOptions ??
              (model.thinkingSet !== undefined ? thinkingSets[model.thinkingSet]?.options : undefined) ??
              []
            ).map((option) => ({ id: option.id, label: option.label })),
          })),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function readState(context: PluginHandlerContext): Promise<RoutingState> {
  let raw: Buffer | null = null;
  try {
    raw = await readFile(ROUTING_FILE);
  } catch (error) {
    // A new install has no file yet: say so, and let the screen offer to create one.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let routing: Routing | null = null;
  let parseError: string | null = null;
  if (raw) {
    try {
      routing = parseRouting(raw.toString("utf8"));
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }
  let providers: ProviderOption[] = [];
  let providersError: string | null = null;
  try {
    providers = await listProviders(context);
  } catch (error) {
    providersError = error instanceof Error ? error.message : String(error);
  }
  return {
    path: ROUTING_FILE,
    revision: raw ? revisionOf(raw) : MISSING_ROUTING_REVISION,
    routing,
    parseError,
    providers,
    providersError,
    ...(raw ? {} : { missing: true }),
  };
}

export function readRouting(_input: Record<string, never>, context: PluginHandlerContext) {
  return readState(context);
}

export function createRouting(_input: Record<string, never>, context: PluginHandlerContext): Promise<RoutingState> {
  return serialized(async () => {
    await mkdir(dirname(ROUTING_FILE), { recursive: true });
    try {
      // `wx` fails when the file exists, so a file made since the screen loaded is never overwritten.
      await writeFile(ROUTING_FILE, starterRouting(), { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("model-routing.md already exists. Reload to see it; nothing was changed.");
      }
      throw error;
    }
    console.log(`Created ${ROUTING_FILE}`);
    return readState(context);
  });
}

function validate(routing: Routing, providers: ProviderOption[]): void {
  const known = new Map(providers.map((provider) => [provider.id, provider]));
  for (const preset of routing.presets) {
    const tiers = preset.routes.map((route) => route.tier);
    if (new Set(tiers).size !== tiers.length) {
      throw new Error(`Preset ${preset.name}: duplicate tier.`);
    }
    for (const route of preset.routes) {
      const where = `${preset.name}/${route.tier}`;
      if (route.provider === NO_PROVIDER) continue;
      // Providers missing from the snapshot are kept as written: discovery can lag or
      // the provider may be disabled for now. Only check models of known providers.
      const provider = known.get(route.provider);
      if (provider && provider.models.length > 0 && route.model &&
          !provider.models.some((model) => model.id === route.model)) {
        throw new Error(`${where}: ${route.provider} has no model ${route.model}.`);
      }
    }
  }
}

async function writeRouting(raw: Buffer, routing: Routing): Promise<void> {
  const next = applyRouting(raw.toString("utf8"), routing);
  // Round-trip check: never write a file the next read cannot parse back.
  parseRouting(next);
  const temporary = `${ROUTING_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, next, "utf8");
  await rename(temporary, ROUTING_FILE);
}

async function readRoutingChecked(revision: string): Promise<Buffer> {
  const raw = await readFile(ROUTING_FILE);
  if (revisionOf(raw) !== revision) {
    throw new Error("model-routing.md changed since it was loaded. Reload and apply the change again.");
  }
  return raw;
}

export function saveRouting(
  input: { revision: string; routing: Routing },
  context: PluginHandlerContext,
): Promise<RoutingState> {
  return serialized(async () => {
    const raw = await readRoutingChecked(input.revision);
    const state = await readState(context);
    validate(input.routing, state.providers);
    // A set a scope names must not disappear through a whole-file save.
    if (state.routing) {
      assertNoReferencedRemoval(state.routing, input.routing, (await readScopesFile(SCOPES_FILE)).scopes);
    }
    await writeRouting(raw, input.routing);
    console.log(`Saved ${ROUTING_FILE}: active=${input.routing.active}`);
    return readState(context);
  });
}

/** Create, duplicate, rename or delete a set. Rename also rewrites the scope entries naming it. */
export function manageSet(
  input: { revision: string; op: SetOp },
  context: PluginHandlerContext,
): Promise<RoutingState> {
  return serialized(async () => {
    const raw = await readRoutingChecked(input.revision);
    const routing = parseRouting(raw.toString("utf8"));
    const scopesFile = await readScopesFile(SCOPES_FILE);
    const result = applySetOp(routing, input.op, scopesFile.scopes);
    const state = await readState(context);
    validate(result.routing, state.providers);
    await writeRouting(raw, result.routing);
    if (result.scopes) {
      try {
        await writeScopesFile(SCOPES_FILE, scopesFile.revision, result.scopes);
      } catch (error) {
        // Keep the two files consistent: put the routing file back before reporting.
        const temporary = `${ROUTING_FILE}.${process.pid}.tmp`;
        await writeFile(temporary, raw);
        await rename(temporary, ROUTING_FILE);
        throw error;
      }
    }
    console.log(`Set ${input.op.kind} in ${ROUTING_FILE}`);
    return readState(context);
  });
}

// ---- scopes ----

type ListedWorkspace = { id: string; name: string; projectId: string; directory: string | null };
type ListedProject = { id: string; name: string; rootPath: string };

async function listWorkspaces(context: PluginHandlerContext): Promise<ListedWorkspace[]> {
  const out: ListedWorkspace[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const result = await context.paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const entry of result.entries) {
      out.push({
        id: entry.id,
        name: entry.name,
        projectId: entry.projectId,
        directory: entry.workspaceDirectory ?? null,
      });
    }
    cursor = result.pageInfo.nextCursor ?? undefined;
    if (!result.pageInfo.hasMore || !cursor) break;
  }
  return out;
}

async function listProjects(context: PluginHandlerContext): Promise<ListedProject[]> {
  const result = await context.paseo.projects.list();
  return result.projects.map((project) => ({
    id: project.projectId,
    name: project.projectDisplayName,
    rootPath: project.projectRootPath,
  }));
}

async function readRoutingQuiet(): Promise<{ routing: Routing | null; error: string | null }> {
  try {
    return { routing: parseRouting(await readFile(ROUTING_FILE, "utf8")), error: null };
  } catch (error) {
    return { routing: null, error: error instanceof Error ? error.message : String(error) };
  }
}

const NO_ROUTING = (error: string | null) => ({
  set: null,
  scope: { kind: "global" as const, id: null },
  enforced: false,
  error: error ?? "model-routing.md is unavailable.",
});

async function readScopesState(context: PluginHandlerContext): Promise<ScopesState> {
  const file = await readScopesFile(SCOPES_FILE);
  const { routing, error: routingError } = await readRoutingQuiet();
  const errors: string[] = [];
  let projects: ListedProject[] = [];
  let workspaces: ListedWorkspace[] = [];
  try {
    projects = await listProjects(context);
  } catch (error) {
    errors.push(`projects: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    workspaces = await listWorkspaces(context);
  } catch (error) {
    errors.push(`workspaces: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    path: SCOPES_FILE,
    revision: file.revision,
    exists: file.exists,
    scopes: file.scopes,
    parseError: file.error,
    globalSet: routing?.active ?? null,
    sets: routing?.presets.map((preset) => preset.name) ?? [],
    routingError,
    projects,
    workspaces: workspaces.map((workspace) => ({
      ...workspace,
      effective: routing
        ? resolveEffective(file.scopes, routing, workspace.id, workspace.projectId)
        : NO_ROUTING(routingError),
    })),
    listError: errors.length > 0 ? errors.join("; ") : null,
  };
}

export function readScopes(_input: Record<string, never>, context: PluginHandlerContext) {
  return readScopesState(context);
}

export function saveScopes(input: { revision: string; scopes: Scopes }, context: PluginHandlerContext) {
  return serialized(async () => {
    if (input.scopes.global.enforce) {
      throw new Error("Global enforcement is off in this version; enforce per workspace or project.");
    }
    const routing = parseRouting(await readFile(ROUTING_FILE, "utf8"));
    const names = new Set(routing.presets.map((preset) => preset.name));
    const entries = [
      ...Object.entries(input.scopes.projects).map(([id, entry]) => [`project:${id}`, entry.set] as const),
      ...Object.entries(input.scopes.workspaces).map(([id, entry]) => [`workspace:${id}`, entry.set] as const),
    ];
    const unknown = entries.filter(([, set]) => !names.has(set));
    if (unknown.length > 0) {
      throw new Error(`Unknown set: ${unknown.map(([where, set]) => `${where} uses \`${set}\``).join(", ")}.`);
    }
    await writeScopesFile(SCOPES_FILE, input.revision, input.scopes);
    console.log(`Saved ${SCOPES_FILE}: ${entries.length} scope entries`);
    return readScopesState(context);
  });
}

export async function resolveScope(
  input: { workspaceId: string; projectId?: string },
  context: PluginHandlerContext,
): Promise<ResolveOutput> {
  const file = await readScopesFile(SCOPES_FILE);
  const { routing, error } = await readRoutingQuiet();
  let projectId = input.projectId ?? null;
  if (!projectId) {
    const workspace = await context.paseo.workspaces.ref(input.workspaceId).refresh();
    projectId = workspace?.projectId ?? null;
  }
  if (!routing) {
    return { workspaceId: input.workspaceId, projectId, effective: NO_ROUTING(error), views: null };
  }
  const effective = resolveEffective(file.scopes, routing, input.workspaceId, projectId);
  if (file.error && !effective.error) effective.error = `Scopes file: ${file.error}`;
  // roleView is null for a set that does not exist, so a dangling scope shows no rows.
  const views = effective.set
    ? { lead: roleView(routing, effective.set, "lead"), peer: roleView(routing, effective.set, "peer") }
    : null;
  return { workspaceId: input.workspaceId, projectId, effective, views };
}
