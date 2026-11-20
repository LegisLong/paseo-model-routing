import type { Routing } from "../shared/routing";
import { PRESET_NAME } from "../shared/routing";
import type { Scopes, SetOp } from "../shared/scopes";
import { setInUseMessage } from "../shared/scopes";
import { setReferences } from "./scopes-file";

// Set (preset) management on top of the md editor. A set that a scope names is never
// dropped silently: delete is refused, rename rewrites the scope entries explicitly.

export class SetOpError extends Error {}

function has(routing: Routing, name: string): boolean {
  return routing.presets.some((preset) => preset.name === name);
}

function requireNewName(routing: Routing, name: string): void {
  if (!PRESET_NAME.test(name)) throw new SetOpError(`Bad set name \`${name}\`: use letters, digits, - and _.`);
  if (has(routing, name)) throw new SetOpError(`Set \`${name}\` already exists.`);
}

function requireExisting(routing: Routing, name: string): void {
  if (!has(routing, name)) throw new SetOpError(`Set \`${name}\` does not exist.`);
}

/**
 * Refuse a routing save that removes a set named by a scope (a rename through `routing.save`
 * looks like a removal). `scopes` null means the scopes file is unreadable: then no set may go.
 */
export function assertNoReferencedRemoval(current: Routing, next: Routing, scopes: Scopes | null): void {
  const kept = new Set(next.presets.map((preset) => preset.name));
  const removed = current.presets.map((preset) => preset.name).filter((name) => !kept.has(name));
  if (removed.length === 0) return;
  if (!scopes) {
    throw new SetOpError(
      `Cannot remove ${removed.join(", ")}: model-routing-scopes.json is unreadable, so references cannot be checked.`,
    );
  }
  const refs = setReferences(scopes);
  const blocked = removed.filter((name) => refs.has(name));
  if (blocked.length > 0) {
    throw new SetOpError(blocked.map((name) => setInUseMessage(name, refs.get(name) ?? [])).join(" "));
  }
}

export type SetOpResult = {
  routing: Routing;
  /** Changed scopes to write, or null when the scopes file needs no change. */
  scopes: Scopes | null;
};

/** Apply one set operation. `scopes` null means the scopes file is unreadable. */
export function applySetOp(routing: Routing, op: SetOp, scopes: Scopes | null): SetOpResult {
  switch (op.kind) {
    case "create": {
      requireNewName(routing, op.name);
      return {
        routing: { ...routing, presets: [...routing.presets, { name: op.name, summary: op.summary, routes: op.routes }] },
        scopes: null,
      };
    }
    case "duplicate": {
      requireExisting(routing, op.from);
      requireNewName(routing, op.name);
      const source = routing.presets.find((preset) => preset.name === op.from)!;
      const copy = {
        name: op.name,
        summary: op.summary ?? source.summary,
        routes: source.routes.map((route) => ({ ...route })),
      };
      return { routing: { ...routing, presets: [...routing.presets, copy] }, scopes: null };
    }
    case "rename": {
      requireExisting(routing, op.from);
      requireNewName(routing, op.to);
      if (!scopes) {
        throw new SetOpError(`Cannot rename \`${op.from}\`: model-routing-scopes.json is unreadable.`);
      }
      const presets = routing.presets.map((preset) =>
        preset.name === op.from ? { ...preset, name: op.to } : preset,
      );
      const active = routing.active === op.from ? op.to : routing.active;
      const retarget = (record: Scopes["projects"]) =>
        Object.fromEntries(
          Object.entries(record).map(([id, entry]) => [id, entry.set === op.from ? { ...entry, set: op.to } : entry]),
        );
      const referenced = setReferences(scopes).has(op.from);
      return {
        routing: { active, presets },
        scopes: referenced
          ? { ...scopes, projects: retarget(scopes.projects), workspaces: retarget(scopes.workspaces) }
          : null,
      };
    }
    case "delete": {
      requireExisting(routing, op.name);
      if (routing.active === op.name) {
        throw new SetOpError(`Cannot delete \`${op.name}\`: it is the global default. Pick another global default first.`);
      }
      const next = { ...routing, presets: routing.presets.filter((preset) => preset.name !== op.name) };
      assertNoReferencedRemoval(routing, next, scopes);
      return { routing: next, scopes: null };
    }
  }
}
