import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { routeSchema, routingStateSchema } from "./routing";

// Scoped routing: which preset ("set") applies to a workspace or project, and whether the
// freshness guard enforces it there. Stored in model-routing-scopes.json beside model-routing.md.

export const scopeEntrySchema = z
  .object({
    set: z.string().min(1),
    enforce: z.boolean(),
  })
  .strict();

/**
 * Which agents count as a Supervisor or a Lead, for the guard. `role` is the role of the agent
 * that creates: a `supervisor` creates Leads, a `lead` creates Peers. Not to be confused with
 * `Role` below, which names what is being created.
 */
export const roleRuleSchema = z
  .object({
    match: z
      .object({
        /** Exact provider id, or a pattern where `*` matches any run of characters. */
        provider: z.string().min(1).optional(),
        /** Every key/value pair must be present on the creating agent. */
        labels: z.record(z.string().min(1), z.string().min(1)).optional(),
      })
      .strict()
      .refine((match) => match.provider !== undefined || Object.keys(match.labels ?? {}).length > 0, {
        message: "match needs a provider or at least one label",
      }),
    role: z.enum(["supervisor", "lead"]),
  })
  .strict();

export const scopesSchema = z
  .object({
    version: z.literal(1),
    global: z.object({ enforce: z.boolean() }).strict(),
    /** Absent: the default rules apply. Present, even empty: only these rules apply. */
    roles: z.array(roleRuleSchema).optional(),
    projects: z.record(z.string().min(1), scopeEntrySchema),
    workspaces: z.record(z.string().min(1), scopeEntrySchema),
  })
  .strict();

/** Revision reported while the scopes file does not exist. Save with it to create the file. */
export const MISSING_SCOPES_REVISION = "missing";

export const scopeKindSchema = z.enum(["workspace", "project", "global"]);

/** The role being created: Supervisor creates `lead`, Lead creates `peer`. */
export const roleSchema = z.enum(["lead", "peer"]);

export const effectiveRoutingSchema = z.object({
  /** Effective set name; null when model-routing.md cannot be parsed. */
  set: z.string().nullable(),
  scope: z.object({ kind: scopeKindSchema, id: z.string().nullable() }),
  /** True only when the winning entry has enforce: true and its set exists. */
  enforced: z.boolean(),
  /** Configuration problem, for example a scope naming a set that no longer exists. */
  error: z.string().nullable(),
});

export const roleViewSchema = z.object({
  role: roleSchema,
  /** The value creations must carry in the `routing-rev` label. */
  revision: z.string(),
  routes: z.array(routeSchema),
});

export const scopesStateSchema = z.object({
  path: z.string(),
  revision: z.string(),
  exists: z.boolean(),
  /** File content, or the empty default when the file is missing; null when it is invalid. */
  scopes: scopesSchema.nullable(),
  parseError: z.string().nullable(),
  /** Global default set (the `active:` line of model-routing.md). */
  globalSet: z.string().nullable(),
  sets: z.array(z.string()),
  routingError: z.string().nullable(),
  projects: z.array(
    z.object({ id: z.string(), name: z.string(), rootPath: z.string() }),
  ),
  workspaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      projectId: z.string(),
      directory: z.string().nullable(),
      effective: effectiveRoutingSchema,
    }),
  ),
  /** Set when the daemon could not list projects or workspaces; the lists are then partial. */
  listError: z.string().nullable(),
});

export const resolveOutputSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string().nullable(),
  effective: effectiveRoutingSchema,
  /** Null when the effective set cannot be read. A role is null when the set has no rows for it. */
  views: z
    .object({ lead: roleViewSchema.nullable(), peer: roleViewSchema.nullable() })
    .nullable(),
});

export const setOpSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    name: z.string().min(1),
    summary: z.string().default(""),
    routes: z.array(routeSchema).min(1),
  }),
  z.object({
    kind: z.literal("duplicate"),
    from: z.string().min(1),
    name: z.string().min(1),
    summary: z.string().optional(),
  }),
  z.object({ kind: z.literal("rename"), from: z.string().min(1), to: z.string().min(1) }),
  z.object({ kind: z.literal("delete"), name: z.string().min(1) }),
]);

export type ScopeEntry = z.infer<typeof scopeEntrySchema>;
export type RoleRule = z.infer<typeof roleRuleSchema>;
export type Scopes = z.infer<typeof scopesSchema>;
export type ScopeKind = z.infer<typeof scopeKindSchema>;
export type Role = z.infer<typeof roleSchema>;
export type EffectiveRouting = z.infer<typeof effectiveRoutingSchema>;
export type RoleView = z.infer<typeof roleViewSchema>;
export type ScopesState = z.infer<typeof scopesStateSchema>;
export type ResolveOutput = z.infer<typeof resolveOutputSchema>;
export type SetOp = z.infer<typeof setOpSchema>;

export const readScopesRpc = defineRpc({
  name: "routing.scopes.read",
  input: z.object({}),
  output: scopesStateSchema,
});

export const saveScopesRpc = defineRpc({
  name: "routing.scopes.save",
  input: z.object({ revision: z.string(), scopes: scopesSchema }),
  output: scopesStateSchema,
});

export const resolveScopeRpc = defineRpc({
  name: "routing.scopes.resolve",
  input: z.object({ workspaceId: z.string().min(1), projectId: z.string().min(1).optional() }),
  output: resolveOutputSchema,
});

// ---- pure helpers shared by the plugin server and the screen ----

export const EMPTY_SCOPES: Scopes = { version: 1, global: { enforce: false }, projects: {}, workspaces: {} };

/**
 * Workspace entry > project entry > global default (`active:`). The winning entry alone decides
 * enforcement, so a workspace entry with enforce: false opts out of an enforcing project.
 */
export function resolveEffective(
  scopes: Scopes | null,
  routing: { active: string; presets: readonly { name: string }[] },
  workspaceId: string | null,
  projectId: string | null,
): EffectiveRouting {
  const table = scopes ?? EMPTY_SCOPES;
  let result: EffectiveRouting;
  const workspaceEntry = workspaceId ? table.workspaces[workspaceId] : undefined;
  const projectEntry = projectId ? table.projects[projectId] : undefined;
  if (workspaceEntry) {
    result = { set: workspaceEntry.set, scope: { kind: "workspace", id: workspaceId }, enforced: workspaceEntry.enforce, error: null };
  } else if (projectEntry) {
    result = { set: projectEntry.set, scope: { kind: "project", id: projectId }, enforced: projectEntry.enforce, error: null };
  } else {
    result = { set: routing.active, scope: { kind: "global", id: null }, enforced: table.global.enforce, error: null };
  }
  if (!routing.presets.some((preset) => preset.name === result.set)) {
    return { ...result, enforced: false, error: `Set \`${result.set}\` does not exist in model-routing.md.` };
  }
  return result;
}

/** "a", "a and b", "a, b and c", "a, b, c and 2 more". */
export function listPhrase(items: readonly string[], max = 3): string {
  if (items.length > max) return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Refusal for removing a set that scopes still name. The server passes `workspace:<id>` /
 * `project:<id>` references (it has no names at hand); the screen replaces them with names.
 */
export function setInUseMessage(set: string, refs: readonly string[]): string {
  return `Set \`${set}\` is still used by ${listPhrase(refs)}. Reassign ${refs.length === 1 ? "it" : "them"} first.`;
}

export const manageSetRpc = defineRpc({
  name: "routing.sets.manage",
  input: z.object({ revision: z.string(), op: setOpSchema }),
  output: routingStateSchema,
});

// ---- agent roles for the guard ----

/** Applied when the scopes file has no `roles`: the provider-id suffix convention of version 0.1.0. */
export const DEFAULT_ROLE_RULES: readonly RoleRule[] = [
  { match: { provider: "*-supervisor" }, role: "supervisor" },
  { match: { provider: "*-lead" }, role: "lead" },
];

/** The parts of a creating agent that rules can match. */
export type RoleSubject = { provider: string | null; labels?: Record<string, string> };

export type RoleAssignment = {
  /** What the creator is allowed to create: a Supervisor creates `lead`, a Lead creates `peer`. */
  role: Role;
  rule: RoleRule;
  /** Position in the rules in effect. */
  index: number;
  source: "default" | "custom";
};

/** `*` matches any run of characters (including none); everything else is literal and case-sensitive. */
export function matchesProvider(pattern: string, provider: string): boolean {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`, "s").test(provider);
}

export function ruleMatches(rule: RoleRule, subject: RoleSubject): boolean {
  const { provider, labels } = rule.match;
  if (provider !== undefined && (subject.provider === null || !matchesProvider(provider, subject.provider))) return false;
  return Object.entries(labels ?? {}).every(([key, value]) => subject.labels?.[key] === value);
}

/** First matching rule wins. `rules` undefined means the defaults; an empty list assigns nobody. */
export function assignRole(rules: readonly RoleRule[] | undefined, subject: RoleSubject | null): RoleAssignment | null {
  if (!subject) return null;
  const source = rules === undefined ? "default" : "custom";
  const list = rules ?? DEFAULT_ROLE_RULES;
  const index = list.findIndex((rule) => ruleMatches(rule, subject));
  if (index < 0) return null;
  const rule = list[index];
  return { role: rule.role === "supervisor" ? "lead" : "peer", rule, index, source };
}

/** "provider *-lead, labels team-role=lead" for messages and the screen. */
export function describeMatch(match: RoleRule["match"]): string {
  const labels = Object.entries(match.labels ?? {}).map(([key, value]) => `${key}=${value}`);
  return [match.provider !== undefined ? `provider ${match.provider}` : null, labels.length ? `labels ${labels.join(", ")}` : null]
    .filter(Boolean)
    .join(", ");
}

export function describeAssignment(assignment: RoleAssignment): string {
  const who = assignment.rule.role === "supervisor" ? "Supervisor" : "Lead";
  const where = assignment.source === "default" ? "default rule" : `rule ${assignment.index + 1} of roles`;
  return `${who} by ${where} (${describeMatch(assignment.rule.match)})`;
}
