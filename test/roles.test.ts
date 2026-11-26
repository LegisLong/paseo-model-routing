/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { RoleRule, Scopes } from "../shared/scopes";
import { assignRole, DEFAULT_ROLE_RULES, describeAssignment, matchesProvider } from "../shared/scopes";
import { guardDecision, type GuardFacts, PARENT_AGENT_ID_LABEL, ROUTING_REV_LABEL } from "../server/guard";
import { parseRouting } from "../server/routing-file";
import {
  EMPTY_SCOPES,
  parseScopes,
  readScopesFile,
  renderScopes,
  roleView,
  writeScopesFile,
} from "../server/scopes-file";
import { ROUTING_MD } from "./fixture";

const routing = parseRouting(ROUTING_MD);

const supervisor = (match: RoleRule["match"]): RoleRule => ({ match, role: "supervisor" });
const lead = (match: RoleRule["match"]): RoleRule => ({ match, role: "lead" });
const created = (rules: RoleRule[] | undefined, provider: string | null, labels?: Record<string, string>) =>
  assignRole(rules, { provider, labels })?.role ?? null;

describe("provider patterns", () => {
  test("exact unless `*` is used; anchored; case-sensitive; other characters are literal", () => {
    assert.equal(matchesProvider("claude", "claude"), true);
    assert.equal(matchesProvider("claude", "claude-lead"), false);
    assert.equal(matchesProvider("claude", "Claude"), false);
    assert.equal(matchesProvider("*-lead", "example-lead"), true);
    assert.equal(matchesProvider("*-lead", "-lead"), true);
    assert.equal(matchesProvider("*-lead", "example-lead-2"), false);
    assert.equal(matchesProvider("a*c", "abbbc"), true);
    assert.equal(matchesProvider("a*c", "ac"), true);
    assert.equal(matchesProvider("*", "anything"), true);
    assert.equal(matchesProvider("a.b", "axb"), false);
    assert.equal(matchesProvider("a.b", "a.b"), true);
    assert.equal(matchesProvider("a(b)+", "a(b)+"), true);
  });
});

describe("role rules", () => {
  test("no `roles`: the default suffix rules, the same as 0.1.0", () => {
    assert.deepEqual(DEFAULT_ROLE_RULES.map((rule) => [rule.match.provider, rule.role]), [
      ["*-supervisor", "supervisor"],
      ["*-lead", "lead"],
    ]);
    assert.equal(created(undefined, "x-supervisor"), "lead");
    assert.equal(created(undefined, "x-lead"), "peer");
    assert.equal(created(undefined, "x-peer"), null);
    assert.equal(created(undefined, "claude", { "team-role": "lead" }), null);
    assert.equal(assignRole(undefined, { provider: "x-lead" })?.source, "default");
  });

  test("`roles: []` assigns nobody, not even the default suffixes", () => {
    assert.equal(created([], "x-supervisor"), null);
    assert.equal(created([], "x-lead"), null);
  });

  test("custom rules replace the defaults", () => {
    const rules = [lead({ provider: "codex" })];
    assert.equal(created(rules, "codex"), "peer");
    assert.equal(created(rules, "x-supervisor"), null);
    assert.equal(assignRole(rules, { provider: "codex" })?.source, "custom");
  });

  test("the first matching rule wins", () => {
    const labels = { "team-role": "supervisor" };
    const specificFirst = [supervisor({ provider: "claude", labels }), lead({ provider: "claude" })];
    assert.equal(created(specificFirst, "claude", labels), "lead");
    assert.equal(created(specificFirst, "claude"), "peer");
    const generalFirst = [lead({ provider: "claude" }), supervisor({ provider: "claude", labels })];
    assert.equal(created(generalFirst, "claude", labels), "peer");
    assert.equal(assignRole(generalFirst, { provider: "claude", labels })?.index, 0);
  });

  test("labels: every pair must be present with the same value", () => {
    const rules = [lead({ labels: { "team-role": "lead", area: "web" } })];
    assert.equal(created(rules, "any", { "team-role": "lead", area: "web", extra: "1" }), "peer");
    assert.equal(created(rules, "any", { "team-role": "lead" }), null);
    assert.equal(created(rules, "any", { "team-role": "lead", area: "api" }), null);
    assert.equal(created(rules, "any"), null);
    // A labels-only rule matches an agent whose provider is unknown.
    assert.equal(created(rules, null, { "team-role": "lead", area: "web" }), "peer");
  });

  test("provider and labels must both match when both are given", () => {
    const rules = [lead({ provider: "claude", labels: { "team-role": "lead" } })];
    assert.equal(created(rules, "claude", { "team-role": "lead" }), "peer");
    assert.equal(created(rules, "codex", { "team-role": "lead" }), null);
    assert.equal(created(rules, "claude", {}), null);
    assert.equal(created(rules, null, { "team-role": "lead" }), null);
  });

  test("no subject, no role", () => {
    assert.equal(assignRole(undefined, null), null);
  });
});

describe("saving roles", () => {
  let dir = "";
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  const withRoles = (roles: unknown) => ({ ...EMPTY_SCOPES, roles }) as unknown as Scopes;

  test("a match needs a provider or a label; unknown keys and roles are refused", () => {
    const bad: Array<[string, unknown]> = [
      ["empty match", [{ match: {}, role: "lead" }]],
      ["empty labels", [{ match: { labels: {} }, role: "lead" }]],
      ["empty provider", [{ match: { provider: "" }, role: "lead" }]],
      ["empty label value", [{ match: { labels: { a: "" } }, role: "lead" }]],
      ["unknown match key", [{ match: { provider: "x", model: "m" }, role: "lead" }]],
      ["unknown rule key", [{ match: { provider: "x" }, role: "lead", note: "n" }]],
      ["role peer", [{ match: { provider: "x" }, role: "peer" }]],
      ["not an array", { match: { provider: "x" }, role: "lead" }],
    ];
    for (const [name, roles] of bad) {
      assert.throws(() => parseScopes(JSON.stringify(withRoles(roles))), /Scopes file invalid at roles/, name);
    }
  });

  test("write is refused for an invalid rule and leaves the file alone", async () => {
    dir = await mkdtemp(join(tmpdir(), "model-routing-roles-"));
    const path = join(dir, "model-routing-scopes.json");
    await assert.rejects(writeScopesFile(path, "missing", withRoles([{ match: {}, role: "lead" }])));
    assert.equal((await readScopesFile(path)).exists, false);
  });

  test("roles survive a save and read; an absent key stays absent; [] stays []", async () => {
    dir = dir || (await mkdtemp(join(tmpdir(), "model-routing-roles-")));
    const path = join(dir, "model-routing-scopes.json");
    const rules: RoleRule[] = [
      supervisor({ provider: "*-supervisor" }),
      lead({ provider: "claude", labels: { "team-role": "lead" } }),
    ];
    await writeScopesFile(path, "missing", { ...EMPTY_SCOPES, roles: rules });
    const first = await readScopesFile(path);
    assert.deepEqual(first.scopes?.roles, rules);

    await writeScopesFile(path, first.revision, { ...first.scopes!, roles: [] });
    const second = await readScopesFile(path);
    assert.deepEqual(second.scopes?.roles, []);
    assert.match(await readFile(path, "utf8"), /"roles": \[\]/);

    const { roles: _dropped, ...withoutRoles } = second.scopes!;
    await writeScopesFile(path, second.revision, withoutRoles);
    const third = await readScopesFile(path);
    assert.equal(third.scopes?.roles, undefined);
    assert.doesNotMatch(await readFile(path, "utf8"), /roles/);
    // Files written by 0.1.0 have no `roles` and render unchanged.
    assert.equal(renderScopes(EMPTY_SCOPES), renderScopes(parseScopes(renderScopes(EMPTY_SCOPES))));
  });

  test("a stale revision refuses a roles change", async () => {
    dir = dir || (await mkdtemp(join(tmpdir(), "model-routing-roles-")));
    const path = join(dir, "model-routing-scopes.json");
    const current = await readScopesFile(path);
    await assert.rejects(
      writeScopesFile(path, "0".repeat(64), { ...current.scopes!, roles: [lead({ provider: "x" })] }),
      /changed since it was loaded/,
    );
  });
});

describe("guard with role rules", () => {
  const peerRev = roleView(routing, "quality", "peer")!.revision;
  const leadRev = roleView(routing, "quality", "lead")!.revision;
  const scopes = (roles?: RoleRule[]): Scopes => ({
    ...EMPTY_SCOPES,
    ...(roles ? { roles } : {}),
    projects: { p1: { set: "quality", enforce: true } },
  });
  function facts(patch: Partial<GuardFacts>, labels: Record<string, string> = {}): GuardFacts {
    return {
      request: {
        reason: "create",
        purpose: "interactive",
        workspaceId: "w1",
        labels: { [PARENT_AGENT_ID_LABEL]: "parent", ...labels },
      },
      fresh: true,
      scopes: scopes(),
      routing,
      projectId: "p1",
      parent: { provider: "example-lead" },
      ...patch,
    };
  }

  test("without roles a plain provider is not guarded, as in 0.1.0", () => {
    assert.equal(guardDecision(facts({ parent: { provider: "claude", labels: { "team-role": "lead" } } })).kind, "allow");
    assert.equal(guardDecision(facts({})).kind, "reject");
  });

  test("a label rule guards a plain provider and the refusal names the rule", () => {
    const rules = [lead({ provider: "claude", labels: { "team-role": "lead" } })];
    const input = facts({ scopes: scopes(rules), parent: { provider: "claude", labels: { "team-role": "lead" } } });
    const decision = guardDecision(input);
    assert.equal(decision.kind, "reject");
    if (decision.kind !== "reject") return;
    assert.ok(decision.message.includes("Creator role: Lead by rule 1 of roles (provider claude, labels team-role=lead)."));
    assert.ok(decision.message.includes(`rev ${peerRev}`));
    assert.equal(
      guardDecision({ ...input, request: { ...input.request, labels: { ...input.request.labels, [ROUTING_REV_LABEL]: peerRev } } }).kind,
      "allow",
    );
    // Same provider without the label has no role.
    assert.equal(guardDecision({ ...input, parent: { provider: "claude", labels: {} } }).kind, "allow");
  });

  test("a supervisor rule asks for the lead view", () => {
    const input = facts({ scopes: scopes([supervisor({ labels: { "team-role": "supervisor" } })]), parent: { provider: "codex", labels: { "team-role": "supervisor" } } });
    const decision = guardDecision(input);
    assert.equal(decision.kind, "reject");
    if (decision.kind === "reject") {
      assert.ok(decision.message.includes(`rev ${leadRev}`));
      assert.match(decision.message, /Creator role: Supervisor by rule 1 of roles/);
    }
  });

  test("the default rule is named when roles is absent", () => {
    const decision = guardDecision(facts({}));
    assert.equal(decision.kind, "reject");
    if (decision.kind === "reject") {
      assert.ok(decision.message.includes("Creator role: Lead by default rule (provider *-lead)."));
    }
  });

  test("`roles: []` turns the guard off for every parent", () => {
    assert.equal(guardDecision(facts({ scopes: scopes([]) })).kind, "allow");
    assert.equal(guardDecision(facts({ scopes: scopes([]), parent: { provider: "x-supervisor" } })).kind, "allow");
  });

  test("describeAssignment", () => {
    const assignment = assignRole([lead({ provider: "a*" })], { provider: "abc" })!;
    assert.equal(describeAssignment(assignment), "Lead by rule 1 of roles (provider a*)");
  });
});

describe("roles on the screen (draft helpers)", () => {
  const model = import("../client/scope-model");

  test("customize copies the defaults; use default drops the key", async () => {
    const { customizeRoles, useDefaultRoles } = await model;
    const custom = customizeRoles(EMPTY_SCOPES);
    assert.deepEqual(custom.roles, [...DEFAULT_ROLE_RULES]);
    assert.notEqual(custom.roles?.[0], DEFAULT_ROLE_RULES[0]);
    assert.equal("roles" in useDefaultRoles(custom), false);
    assert.deepEqual(useDefaultRoles(custom), EMPTY_SCOPES);
  });

  test("add, change, move and remove keep rules schema-shaped and never mutate the input", async () => {
    const { addRule, changeRule, moveRule, removeRule, rolesProblem } = await model;
    const start = addRule(addRule(EMPTY_SCOPES));
    assert.equal(rolesProblem(start), "Role rule 1: Needs a provider or at least one label.");
    const one = changeRule(start, 0, { provider: "claude", role: "supervisor" });
    const two = changeRule(one, 1, { labels: { "team-role": "lead" } });
    assert.equal(rolesProblem(two), null);
    assert.deepEqual(two.roles, [
      { match: { provider: "claude" }, role: "supervisor" },
      { match: { labels: { "team-role": "lead" } }, role: "lead" },
    ]);
    assert.deepEqual(start.roles?.[0], { match: {}, role: "lead" });
    // Clearing the provider or the labels leaves the key out, so the rule is invalid again.
    assert.equal(rolesProblem(changeRule(one, 0, { provider: "" })), "Role rule 1: Needs a provider or at least one label.");
    assert.equal("labels" in (changeRule(two, 1, { labels: {} }).roles?.[1].match ?? {}), false);
    const swapped = moveRule(two, 0, 1);
    assert.deepEqual(swapped.roles?.map((rule) => rule.role), ["lead", "supervisor"]);
    assert.equal(moveRule(two, 0, -1), two);
    assert.equal(moveRule(two, 1, 1), two);
    assert.deepEqual(removeRule(two, 0).roles, [two.roles![1]]);
    // What the screen accepts, the file schema accepts.
    assert.doesNotThrow(() => parseScopes(renderScopes(two)));
  });

  test("label text", async () => {
    const { parseLabelText, formatLabelText } = await model;
    assert.deepEqual(parseLabelText("team-role=lead, area = web"), { labels: { "team-role": "lead", area: "web" }, error: null });
    assert.deepEqual(parseLabelText(""), { labels: {}, error: null });
    assert.equal(parseLabelText("team-role").error, '"team-role" is not key=value.');
    assert.equal(parseLabelText("a=").error, '"a=" is not key=value.');
    assert.equal(parseLabelText("=b").error, '"=b" is not key=value.');
    assert.equal(formatLabelText({ a: "1", b: "2" }), "a=1, b=2");
    assert.equal(formatLabelText(undefined), "");
  });
});
