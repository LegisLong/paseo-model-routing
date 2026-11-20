/// <reference types="node" />
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { Preset, Route, Routing } from "../shared/routing";
import { LEAD_TIER } from "../shared/routing";
import type { Role, RoleView, Scopes } from "../shared/scopes";
import { EMPTY_SCOPES, MISSING_SCOPES_REVISION, resolveEffective, scopesSchema } from "../shared/scopes";

// model-routing-scopes.json: which set applies per workspace/project and whether the
// freshness guard enforces it. A missing file means no scopes and nothing enforced.

export class ScopesFormatError extends Error {}

// The resolver is pure and shared with the screen, which shows it for unsaved drafts.
export { EMPTY_SCOPES, resolveEffective };

export type ScopesFile = {
  exists: boolean;
  revision: string;
  /** EMPTY_SCOPES when the file is missing; null when it cannot be read or parsed. */
  scopes: Scopes | null;
  error: string | null;
};

export function revisionOf(raw: Buffer | string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseScopes(text: string): Scopes {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ScopesFormatError(`Scopes file is not JSON: ${message(error)}`);
  }
  const parsed = scopesSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ScopesFormatError(`Scopes file invalid at ${issue?.path.join(".") || "(root)"}: ${issue?.message}`);
  }
  return parsed.data;
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
}

/** Stable JSON so hand diffs stay small. */
export function renderScopes(scopes: Scopes): string {
  const ordered: Scopes = {
    version: 1,
    global: { enforce: scopes.global.enforce },
    projects: sortedRecord(scopes.projects),
    workspaces: sortedRecord(scopes.workspaces),
  };
  return JSON.stringify(ordered, null, 2) + "\n";
}

export async function readScopesFile(path: string): Promise<ScopesFile> {
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, revision: MISSING_SCOPES_REVISION, scopes: EMPTY_SCOPES, error: null };
    }
    return { exists: true, revision: "unreadable", scopes: null, error: message(error) };
  }
  try {
    return { exists: true, revision: revisionOf(raw), scopes: parseScopes(raw.toString("utf8")), error: null };
  } catch (error) {
    return { exists: true, revision: revisionOf(raw), scopes: null, error: message(error) };
  }
}

/** Compare-and-swap write: refuse when the file changed since `expectedRevision` was read. */
export async function writeScopesFile(path: string, expectedRevision: string, scopes: Scopes): Promise<void> {
  const current = await readScopesFile(path);
  if (current.revision !== expectedRevision) {
    throw new Error("model-routing-scopes.json changed since it was loaded. Reload and apply the change again.");
  }
  const text = renderScopes(scopesSchema.parse(scopes));
  parseScopes(text);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
}

/** Every set a scope entry names, with the entries naming it (`workspace:<id>`, `project:<id>`). */
export function setReferences(scopes: Scopes): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  const add = (set: string, where: string) => refs.set(set, [...(refs.get(set) ?? []), where]);
  for (const [id, entry] of Object.entries(scopes.projects)) add(entry.set, `project:${id}`);
  for (const [id, entry] of Object.entries(scopes.workspaces)) add(entry.set, `workspace:${id}`);
  return refs;
}

/** True when any entry could enforce; lets the guard skip daemon lookups otherwise. */
export function hasEnforcement(scopes: Scopes): boolean {
  return (
    scopes.global.enforce ||
    Object.values(scopes.projects).some((entry) => entry.enforce) ||
    Object.values(scopes.workspaces).some((entry) => entry.enforce)
  );
}

/** Supervisor creates Leads, Lead creates Peers; any other parent is not routed. */
export function roleForParentProvider(provider: string | null | undefined): Role | null {
  if (!provider) return null;
  if (provider.endsWith("-supervisor")) return "lead";
  if (provider.endsWith("-lead")) return "peer";
  return null;
}

export function roleRoutes(preset: Preset, role: Role): Route[] {
  return preset.routes.filter((route) => (route.tier === LEAD_TIER) === (role === "lead"));
}

/** Hash of the set name and the rows this role uses: other presets and other rows do not move it. */
export function viewRevision(set: string, role: Role, routes: Route[]): string {
  const rows = routes
    .map((route) => [route.tier, route.provider, route.model, route.effort, route.note])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return revisionOf(JSON.stringify({ set, role, rows })).slice(0, 12);
}

/** Null when the set does not exist or the role has no rows in it (nothing to route). */
export function roleView(routing: Routing, set: string, role: Role): RoleView | null {
  const preset = routing.presets.find((candidate) => candidate.name === set);
  if (!preset) return null;
  const routes = roleRoutes(preset, role);
  if (routes.length === 0) return null;
  return { role, revision: viewRevision(set, role, routes), routes };
}
