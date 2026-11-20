import type { ProviderOption, Route, Routing } from "../shared/routing";
import { PRESET_NAME } from "../shared/routing";
import type { EffectiveRouting, ScopeKind, Scopes, ScopesState } from "../shared/scopes";
import { resolveEffective, setInUseMessage } from "../shared/scopes";

// Pure helpers for the routing screen: no React, so node --test can run them.

// ---- drafts ----

/** A file's content as loaded, with the revision the server will compare on save. */
export type Snapshot<T> = { revision: string; value: T };

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * What to do with a local draft when the server copy may have moved on.
 * - dirty: the draft differs from the snapshot it was started from.
 * - stale: dirty, and the file changed on disk since. Saving is refused; keep the edits and ask.
 * - follow: take the server copy (first load, or the file changed and nothing local would be lost).
 */
export function draftStatus<T>(base: Snapshot<T> | null, draft: T, server: Snapshot<T> | undefined) {
  const dirty = base !== null && !same(draft, base.value);
  const changedOnDisk = base !== null && server !== undefined && server.revision !== base.revision;
  return {
    dirty,
    stale: dirty && changedOnDisk,
    follow: server !== undefined && (base === null || (changedOnDisk && !dirty)),
  };
}

/** The plugin server refuses a write when its file changed after the client loaded it. */
export function isStaleError(message: string): boolean {
  return /changed since it was loaded/i.test(message);
}

/**
 * The message the owner should read. The host wraps plugin RPC refusals as
 * "Request failed: <message> requestType=... code=..."; keep only <message>.
 */
export function displayError(message: string): string {
  return message
    .replace(/^\s*Request failed:\s*/i, "")
    .replace(/\s*\brequestType=\S+(?:\s+code=\S+)?\s*$/, "")
    .replace(/\s*\bcode=\S+\s*$/, "")
    .trim();
}

export function errorText(error: unknown): string {
  return displayError(error instanceof Error ? error.message : String(error));
}

/** Which file a stale-save refusal is about, from the server's text. */
function staleFile(message: string): string {
  return /model-routing-scopes\.json/.test(message) ? "model-routing-scopes.json" : "model-routing.md";
}

/** What the owner reads after a write is refused because the file changed on disk. */
export function staleSaveMessage(message: string, keptEdits: boolean): string {
  const head = `${staleFile(message)} changed on disk after you opened it, so nothing was written.`;
  return keptEdits
    ? `${head} Your edits are kept on this page. To continue, choose "Reload and discard my edits" and make the change again.`
    : `${head} The page now shows the new file; try again.`;
}

type Names = Pick<ScopesState, "projects" | "workspaces">;

/** How a scope reference reads to the owner: its project or workspace name, never an id. */
export function scopeRefName(ref: string, names: Names): string {
  const [kind, ...rest] = ref.split(":");
  const id = rest.join(":");
  if (kind === "project") {
    const project = names.projects.find((entry) => entry.id === id);
    return project ? `project ${project.name}` : "a project the daemon no longer lists";
  }
  if (kind === "workspace") {
    const workspace = names.workspaces.find((entry) => entry.id === id);
    if (!workspace) return "a workspace the daemon no longer lists";
    const twins = names.workspaces.filter((entry) => entry.name === workspace.name).length;
    const project = names.projects.find((entry) => entry.id === workspace.projectId);
    return twins > 1 && project ? `workspace ${workspace.name} (project ${project.name})` : `workspace ${workspace.name}`;
  }
  return "another scope";
}

/** Replace the server's `workspace:<id>` / `project:<id>` references in a message with names. */
export function nameScopeRefs(message: string, names: Names): string {
  return message.replace(/\b(?:workspace|project):[\w-]+/g, (ref) => scopeRefName(ref, names));
}

/** Entries naming `set`, as `project:<id>` / `workspace:<id>` (projects first, as the server lists them). */
export function setRefs(scopes: Scopes | null, set: string): string[] {
  if (!scopes) return [];
  return [
    ...Object.entries(scopes.projects).filter(([, entry]) => entry.set === set).map(([id]) => `project:${id}`),
    ...Object.entries(scopes.workspaces).filter(([, entry]) => entry.set === set).map(([id]) => `workspace:${id}`),
  ];
}

/** The refusal for deleting a set still in use, with names; null when nothing names it. */
export function setInUseText(scopes: Scopes | null, set: string, names: Names): string | null {
  const refs = setRefs(scopes, set);
  return refs.length ? setInUseMessage(set, refs.map((ref) => scopeRefName(ref, names))) : null;
}

// ---- scope assignments ----

export const INHERIT = "__inherit__";
export type ScopeTable = "projects" | "workspaces";

/** Point a project or workspace at `set`, or remove its entry with INHERIT. New entries do not enforce. */
export function assignSet(scopes: Scopes, table: ScopeTable, id: string, set: string): Scopes {
  const records = { ...scopes[table] };
  if (set === INHERIT) delete records[id];
  else records[id] = { set, enforce: records[id]?.enforce ?? false };
  return table === "projects" ? { ...scopes, projects: records } : { ...scopes, workspaces: records };
}

export function setEnforce(scopes: Scopes, table: ScopeTable, id: string, enforce: boolean): Scopes {
  const entry = scopes[table][id];
  if (!entry) return scopes;
  const records = { ...scopes[table], [id]: { ...entry, enforce } };
  return table === "projects" ? { ...scopes, projects: records } : { ...scopes, workspaces: records };
}

/** Where an effective set comes from, as shown in its badge. */
export function fromLabel(kind: ScopeKind): string {
  return `from ${kind}`;
}

/** The set a project's workspaces inherit: its own entry, else the global default. */
export function projectEffective(scopes: Scopes, projectId: string, globalSet: string) {
  const entry = scopes.projects[projectId];
  return entry ? { set: entry.set, kind: "project" as const } : { set: globalSet, kind: "global" as const };
}

/** What "Inherit" means: the project's set for a workspace in an assigned project, else the global default. */
export function inheritLabel(projectSet: string | null, globalSet: string): string {
  return projectSet ? `Inherit (project: ${projectSet})` : `Inherit (global: ${globalSet})`;
}

/** Number of project and workspace entries naming `set`. */
export function setUsage(scopes: Scopes | null, set: string): number {
  if (!scopes) return 0;
  return [...Object.values(scopes.projects), ...Object.values(scopes.workspaces)].filter((entry) => entry.set === set)
    .length;
}

/** One-line text of an effective set for a badge, e.g. "economy" plus "from project". */
export function effectiveParts(effective: EffectiveRouting) {
  return { set: effective.set ?? "unknown", from: fromLabel(effective.scope.kind) };
}

/**
 * The effective set of a workspace under the scopes and global default shown on the page
 * (the draft), so the Effective column always matches the pickers and switches beside it.
 */
export function draftEffective(
  scopes: Scopes,
  globalSet: string,
  sets: readonly string[],
  workspace: Pick<WorkspaceRow, "id" | "projectId">,
): EffectiveRouting {
  return resolveEffective(scopes, { active: globalSet, presets: sets.map((name) => ({ name })) }, workspace.id, workspace.projectId);
}

/** True when the draft changes what applies to this workspace relative to the saved scopes. */
export function scopeChanged(saved: Scopes, draft: Scopes, workspaceId: string, projectId: string): boolean {
  return (
    !same(saved.workspaces[workspaceId], draft.workspaces[workspaceId]) ||
    !same(saved.projects[projectId], draft.projects[projectId])
  );
}

// ---- project and workspace lists ----

export type WorkspaceRow = ScopesState["workspaces"][number];
export type ProjectGroup = { id: string; name: string; rootPath: string | null; workspaces: WorkspaceRow[] };

function includes(text: string | null | undefined, needle: string): boolean {
  return (text ?? "").toLowerCase().includes(needle);
}

/** Workspaces grouped by project, sorted by name. `query` filters on project/workspace name, path and id. */
export function groupByProject(
  state: Pick<ScopesState, "projects" | "workspaces">,
  query: string,
): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const project of state.projects) {
    groups.set(project.id, { id: project.id, name: project.name, rootPath: project.rootPath, workspaces: [] });
  }
  for (const workspace of state.workspaces) {
    const group = groups.get(workspace.projectId) ?? {
      id: workspace.projectId,
      name: workspace.projectId,
      rootPath: null,
      workspaces: [],
    };
    group.workspaces.push(workspace);
    groups.set(group.id, group);
  }
  const needle = query.trim().toLowerCase();
  const out: ProjectGroup[] = [];
  for (const group of groups.values()) {
    const projectMatches = !needle || [group.name, group.rootPath, group.id].some((text) => includes(text, needle));
    const workspaces = projectMatches
      ? group.workspaces
      : group.workspaces.filter((workspace) =>
          [workspace.name, workspace.directory, workspace.id].some((text) => includes(text, needle)),
        );
    if (projectMatches || workspaces.length > 0) {
      out.push({ ...group, workspaces: [...workspaces].sort((a, b) => a.name.localeCompare(b.name)) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Scope entries whose project or workspace the daemon did not list (for example an archived workspace). */
export function unlistedEntries(scopes: Scopes, state: Pick<ScopesState, "projects" | "workspaces">) {
  const projectIds = new Set([...state.projects.map((p) => p.id), ...state.workspaces.map((w) => w.projectId)]);
  const workspaceIds = new Set(state.workspaces.map((workspace) => workspace.id));
  return {
    projects: Object.keys(scopes.projects).filter((id) => !projectIds.has(id)).sort(),
    workspaces: Object.keys(scopes.workspaces).filter((id) => !workspaceIds.has(id)).sort(),
  };
}

// ---- sets ----

/**
 * How a route row edits its model and effort: pick from the provider's catalogue when the daemon
 * listed one, else type them (catalogue still loading, unavailable, or provider not found).
 */
export function modelEntry(provider: ProviderOption | undefined, model: string) {
  const listed = provider !== undefined && provider.models.length > 0;
  const efforts = provider?.models.find((entry) => entry.id === model)?.efforts ?? [];
  const hint = !provider
    ? "provider not found; type the model"
    : provider.modelsStatus === "loading"
      ? "loading models..."
      : "no model list; type the model";
  return { models: listed ? ("list" as const) : ("text" as const), efforts: efforts.length > 0 ? ("list" as const) : ("text" as const), hint };
}

/** True while the daemon is still discovering some provider's models; the screen reads again until it is done. */
export function providersLoading(providers: readonly ProviderOption[] | undefined): boolean {
  return (providers ?? []).some((provider) => provider.enabled && provider.modelsStatus === "loading");
}

export function formatRoute(route: Route): string {
  if (!route.provider) return "no single model";
  return [route.provider, route.model, route.effort].filter(Boolean).join(" ");
}

/** Null when `name` can be used for a new or renamed set. */
export function nameProblem(existing: readonly string[], name: string): string | null {
  if (!name) return "Enter a name.";
  if (!PRESET_NAME.test(name)) return "Use letters, digits, - and _.";
  if (existing.includes(name)) return `Set \`${name}\` already exists.`;
  return null;
}

export function tierProblem(routes: readonly Route[], tier: string): string | null {
  if (!tier) return "Enter a tier name.";
  if (!PRESET_NAME.test(tier)) return "Use letters, digits, - and _.";
  if (routes.some((route) => route.tier === tier)) return `Tier \`${tier}\` already exists in this set.`;
  return null;
}

function mapPreset(routing: Routing, set: string, change: (routes: Route[]) => Route[]): Routing {
  return {
    ...routing,
    presets: routing.presets.map((preset) =>
      preset.name === set ? { ...preset, routes: change(preset.routes) } : preset,
    ),
  };
}

export function addRoute(routing: Routing, set: string, tier: string): Routing {
  return mapPreset(routing, set, (routes) => [...routes, { tier, provider: "", model: "", effort: "", note: "" }]);
}

export function removeRoute(routing: Routing, set: string, tier: string): Routing {
  return mapPreset(routing, set, (routes) => (routes.length > 1 ? routes.filter((route) => route.tier !== tier) : routes));
}
