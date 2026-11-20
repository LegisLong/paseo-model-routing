/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import type { Route, Routing } from "../shared/routing";
import type { EffectiveRouting, Role, RoleView, Scopes } from "../shared/scopes";
import { parseRouting } from "./routing-file";
import { hasEnforcement, readScopesFile, resolveEffective, roleForParentProvider, roleView } from "./scopes-file";

// Freshness guard for agent creation by a Supervisor (creates Leads) or a Lead (creates Peers).
// A creation in an enforcing scope must carry label `routing-rev` equal to the revision of the
// role's rows in the effective set; otherwise it is refused before any agent exists, with the
// rows and the retry instruction. It never reroutes and never constrains the child's model.
// Every path other than a fresh interactive creation with a parent, and every internal failure,
// returns without throwing.

export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const ROUTING_REV_LABEL = "routing-rev";
/** Agent metadata key stamped by agent.create.before on genuine new creations. */
export const CREATION_MARKER = "model-routing.creation";

/** Fields of the agent.open.before request the guard reads (0.16.2 payload). */
export type OpenRequest = {
  agentId: string;
  workspaceId: string | null;
  reason: string;
  purpose: string;
  labels: Readonly<Record<string, string>>;
  metadata?: Readonly<Record<string, unknown>>;
};

export type GuardDecision =
  | { kind: "allow"; why: string }
  | { kind: "reject"; message: string };

const allow = (why: string): GuardDecision => ({ kind: "allow", why });

/**
 * Nonces stamped by agent.create.before in this plugin process. A stored agent reopened from its
 * record (createAgentFromRecord) also runs agent.create.before, but its record metadata already
 * carries a marker, so no new nonce is stamped and the open counts as a reopen.
 */
export class PendingCreations {
  private readonly stamped = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs = 10 * 60_000) {
    this.ttlMs = ttlMs;
  }

  add(now = Date.now()): string {
    this.prune(now);
    const nonce = randomUUID();
    this.stamped.set(nonce, now);
    return nonce;
  }

  /** True once for a nonce stamped here and not yet taken. */
  take(nonce: unknown, now = Date.now()): boolean {
    this.prune(now);
    if (typeof nonce !== "string") return false;
    return this.stamped.delete(nonce);
  }

  private prune(now: number): void {
    for (const [nonce, at] of this.stamped) {
      if (now - at > this.ttlMs) this.stamped.delete(nonce);
    }
  }
}

/** The facts a decision needs; the hook wrapper gathers them lazily. */
export type GuardFacts = {
  request: Pick<OpenRequest, "reason" | "purpose" | "labels" | "workspaceId">;
  /** The open follows a genuine new creation (its marker was stamped in this process). */
  fresh: boolean;
  scopes: Scopes | null;
  routing: Routing | null;
  projectId: string | null;
  parentProvider: string | null;
};

/** Cheap gate checked before any I/O: only a fresh interactive creation with a parent is guarded. */
export function isGuardedOpen(request: Pick<OpenRequest, "reason" | "purpose" | "labels">, fresh: boolean): boolean {
  return (
    request.reason === "create" &&
    request.purpose === "interactive" &&
    typeof request.labels[PARENT_AGENT_ID_LABEL] === "string" &&
    request.labels[PARENT_AGENT_ID_LABEL].trim() !== "" &&
    fresh
  );
}

/** The pure policy. */
export function guardDecision(facts: GuardFacts): GuardDecision {
  if (!isGuardedOpen(facts.request, facts.fresh)) return allow("not a fresh interactive child creation");
  if (!facts.scopes) return allow("scopes unavailable");
  if (!hasEnforcement(facts.scopes)) return allow("no enforcing scope");
  if (!facts.routing) return allow("routing unavailable");
  const effective = resolveEffective(facts.scopes, facts.routing, facts.request.workspaceId, facts.projectId);
  if (!effective.enforced || !effective.set) return allow(effective.error ?? "scope not enforced");
  const role = roleForParentProvider(facts.parentProvider);
  if (!role) return allow(`parent provider ${facts.parentProvider ?? "unknown"} has no routing role`);
  const view = roleView(facts.routing, effective.set, role);
  if (!view) return allow(`set ${effective.set} has no ${role} rows`);
  const given = facts.request.labels[ROUTING_REV_LABEL];
  if (given === view.revision) return allow("revision current");
  return { kind: "reject", message: rejectMessage(effective, facts.projectId, view, given) };
}

function short(value: string, max: number): string {
  const flat = value.replace(/`/g, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function routeText(route: Route): string {
  const target = [route.provider, route.model, route.effort].filter((part) => part).join(" ") || "-";
  return route.note ? `${route.tier}=${target} (${short(route.note, 70)})` : `${route.tier}=${target}`;
}

function scopeText(effective: EffectiveRouting, projectId: string | null): string {
  if (effective.scope.kind === "workspace") return `workspace ${effective.scope.id}`;
  if (effective.scope.kind === "project") return `project ${effective.scope.id}`;
  return projectId ? `global (project ${projectId})` : "global";
}

function rejectMessage(effective: EffectiveRouting, projectId: string | null, view: RoleView, given: string | undefined): string {
  const label = JSON.stringify({ [ROUTING_REV_LABEL]: view.revision });
  const stale = given ? `label routing-rev ${short(given, 20)} is out of date` : "label routing-rev is missing";
  const roleName = view.role === "lead" ? "Lead" : "Peer";
  return (
    `Paseo model-routing plugin refused this agent creation (owner-configured freshness check). Nothing was created. ` +
    `Reason: ${stale}. ` +
    `Scope ${scopeText(effective, projectId)}, set ${effective.set}, rev ${view.revision}. ` +
    `${roleName} routes: ${view.routes.map(routeText).join("; ")}. ` +
    `Retry the same call with labels ${label} added (keep your other labels). ` +
    `Models outside this table remain allowed when the owner asked for them; nothing is rerouted.`
  );
}

// ---- hook wrappers ----

export type GuardOptions = {
  routingFile: string;
  scopesFile: string;
  /** Whole-evaluation budget; on expiry the creation is allowed. */
  timeoutMs?: number;
  pending?: PendingCreations;
  log?: (line: string) => void;
};

type HookPaseo = Pick<PluginHookContext["paseo"], "agents" | "workspaces">;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

export function createRoutingGuard(options: GuardOptions) {
  const pending = options.pending ?? new PendingCreations();
  const timeoutMs = options.timeoutMs ?? 3000;
  const log = options.log ?? ((line: string) => console.log(line));

  /** agent.create.before: stamp a marker on genuine new creations; never throws. */
  function stampCreation<T extends object>(request: T): T | undefined {
    try {
      const metadata = (request as { metadata?: unknown }).metadata;
      // No metadata channel (older daemon): nothing to stamp, so every open is treated as a reopen.
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
      // Already marked: a stored agent being reopened from its record.
      if (CREATION_MARKER in metadata) return undefined;
      return { ...request, metadata: { ...metadata, [CREATION_MARKER]: pending.add() } };
    } catch {
      return undefined;
    }
  }

  async function evaluate(request: OpenRequest, paseo: HookPaseo): Promise<GuardDecision> {
    const scopesFile = await readScopesFile(options.scopesFile);
    const facts: GuardFacts = {
      request,
      fresh: true,
      scopes: scopesFile.scopes,
      routing: null,
      projectId: null,
      parentProvider: null,
    };
    if (!facts.scopes || !hasEnforcement(facts.scopes)) return guardDecision(facts);
    facts.routing = parseRouting(await readFile(options.routingFile, "utf8"));

    const workspaceId = request.workspaceId;
    const needsProject = !(workspaceId && facts.scopes.workspaces[workspaceId]) &&
      Object.keys(facts.scopes.projects).length > 0;
    if (needsProject && workspaceId) {
      // The workspace, not the child: never fetch the child agent while its lane is held.
      const workspace = await paseo.workspaces.ref(workspaceId).refresh();
      facts.projectId = workspace?.projectId ?? null;
    }
    const effective = resolveEffective(facts.scopes, facts.routing, workspaceId, facts.projectId);
    if (!effective.enforced) return guardDecision(facts);

    const parentId = request.labels[PARENT_AGENT_ID_LABEL].trim();
    const parent = await paseo.agents.ref(parentId).refresh();
    facts.parentProvider = parent?.agent.provider ?? null;
    return guardDecision(facts);
  }

  /** agent.open.before: throw only to refuse a stale fresh creation; everything else returns. */
  async function checkOpen(request: OpenRequest, context: { paseo: HookPaseo; signal?: AbortSignal }): Promise<void> {
    let decision: GuardDecision;
    try {
      if (request.reason !== "create" || request.purpose !== "interactive") return;
      const fresh = pending.take(request.metadata?.[CREATION_MARKER]);
      if (!isGuardedOpen(request, fresh)) return;
      decision = await withTimeout(evaluate(request, context.paseo), timeoutMs);
    } catch (error) {
      log(`model-routing guard allowed ${request.agentId} after an internal failure: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (decision.kind === "allow") return;
    if (context.signal?.aborted) return;
    log(`model-routing guard refused ${request.agentId}: ${decision.message}`);
    throw new Error(decision.message);
  }

  return { stampCreation, checkOpen, pending };
}
