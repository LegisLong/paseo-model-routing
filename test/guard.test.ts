/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Scopes } from "../shared/scopes";
import {
  CREATION_MARKER,
  createRoutingGuard,
  guardDecision,
  type GuardFacts,
  type OpenRequest,
  PARENT_AGENT_ID_LABEL,
  PendingCreations,
  ROUTING_REV_LABEL,
} from "../server/guard";
import { parseRouting } from "../server/routing-file";
import { EMPTY_SCOPES, renderScopes, roleView } from "../server/scopes-file";
import { ROUTING_MD } from "./fixture";

const routing = parseRouting(ROUTING_MD);
const peerRev = roleView(routing, "quality", "peer")!.revision;
const leadRev = roleView(routing, "quality", "lead")!.revision;
const enforcing: Scopes = {
  ...EMPTY_SCOPES,
  projects: { p1: { set: "quality", enforce: true } },
  workspaces: { wOut: { set: "quality", enforce: false } },
};

function facts(patch: Partial<GuardFacts> & { labels?: Record<string, string> } = {}): GuardFacts {
  const { labels, ...rest } = patch;
  return {
    request: {
      reason: "create",
      purpose: "interactive",
      workspaceId: "w1",
      labels: { [PARENT_AGENT_ID_LABEL]: "parent", ...labels },
    },
    fresh: true,
    scopes: enforcing,
    routing,
    projectId: "p1",
    parentProvider: "example-lead",
    ...rest,
  };
}

describe("guardDecision", () => {
  test("Lead creating a Peer without or with a stale revision is refused with rows and retry", () => {
    for (const labels of [{}, { [ROUTING_REV_LABEL]: "old" }] as Array<Record<string, string>>) {
      const decision = guardDecision(facts({ labels }));
      assert.equal(decision.kind, "reject");
      if (decision.kind !== "reject") return;
      assert.match(decision.message, /^Paseo model-routing plugin refused this agent creation \(owner-configured freshness check\)\. Nothing was created\./);
      assert.match(decision.message, /Reason: (label routing-rev is missing|label routing-rev \S+ is out of date)\./);
      assert.match(decision.message, /Scope project p1, set quality, rev /);
      assert.ok(decision.message.includes(`rev ${peerRev}`));
      assert.match(decision.message, /Peer routes: routine=example-peer model-large-5-5 high; light=/);
      assert.doesNotMatch(decision.message, /example-lead/);
      assert.ok(decision.message.includes(`labels {"routing-rev":"${peerRev}"} added`));
      assert.match(decision.message, /nothing is rerouted/);
      assert.ok(!decision.message.includes("\n"));
    }
  });

  test("Supervisor creating a Lead gets the lead view", () => {
    const decision = guardDecision(facts({ parentProvider: "example-supervisor" }));
    assert.equal(decision.kind, "reject");
    if (decision.kind === "reject") {
      assert.ok(decision.message.includes(`rev ${leadRev}`));
      assert.match(decision.message, /Lead routes: lead=example-lead model-large-5-5 high\./);
    }
    const ok = guardDecision(facts({ parentProvider: "example-supervisor", labels: { [ROUTING_REV_LABEL]: leadRev } }));
    assert.equal(ok.kind, "allow");
    // A Peer revision does not satisfy the Lead view.
    assert.equal(guardDecision(facts({ parentProvider: "example-supervisor", labels: { [ROUTING_REV_LABEL]: peerRev } })).kind, "reject");
  });

  test("current revision is allowed", () => {
    assert.equal(guardDecision(facts({ labels: { [ROUTING_REV_LABEL]: peerRev } })).kind, "allow");
  });

  const allowed: Array<[string, GuardFacts]> = [
    ["resume", { ...facts(), request: { ...facts().request, reason: "resume" } }],
    ["refresh", { ...facts(), request: { ...facts().request, reason: "refresh" } }],
    ["import", { ...facts(), request: { ...facts().request, reason: "import" } }],
    ["history open", { ...facts(), request: { ...facts().request, purpose: "history" } }],
    ["no parent label", { ...facts(), request: { ...facts().request, labels: {} } }],
    ["blank parent label", { ...facts(), request: { ...facts().request, labels: { [PARENT_AGENT_ID_LABEL]: " " } } }],
    ["reopen (not fresh)", facts({ fresh: false })],
    ["peer parent", facts({ parentProvider: "example-peer" })],
    ["non-role parent", facts({ parentProvider: "example" })],
    ["unknown parent", facts({ parentProvider: null })],
    ["no scopes file content", facts({ scopes: null })],
    ["no enforcing entry", facts({ scopes: EMPTY_SCOPES })],
    ["routing unreadable", facts({ routing: null })],
    ["other project", facts({ projectId: "p2" })],
    ["workspace opt-out", { ...facts(), request: { ...facts().request, workspaceId: "wOut" } }],
    ["set without lead row", facts({ parentProvider: "example-supervisor", scopes: { ...EMPTY_SCOPES, projects: { p1: { set: "economy", enforce: true } } } })],
    ["dangling set", facts({ scopes: { ...EMPTY_SCOPES, projects: { p1: { set: "gone", enforce: true } } } })],
  ];
  for (const [name, input] of allowed) {
    test(`allows: ${name}`, () => assert.equal(guardDecision(input).kind, "allow"));
  }
});

describe("PendingCreations", () => {
  test("a nonce is taken once and expires", () => {
    const pending = new PendingCreations(1000);
    const nonce = pending.add(0);
    assert.equal(pending.take(nonce, 10), true);
    assert.equal(pending.take(nonce, 20), false);
    const old = pending.add(0);
    assert.equal(pending.take(old, 5000), false);
    assert.equal(pending.take(undefined), false);
  });
});

describe("hook wrappers", () => {
  let dir = "";
  let routingFile = "";
  let scopesFile = "";
  const logs: string[] = [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "model-routing-guard-"));
    routingFile = join(dir, "model-routing.md");
    scopesFile = join(dir, "model-routing-scopes.json");
    await writeFile(routingFile, ROUTING_MD);
    await writeFile(scopesFile, renderScopes(enforcing));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  type Paseo = Parameters<ReturnType<typeof createRoutingGuard>["checkOpen"]>[1]["paseo"];
  type Lookup<T> = () => Promise<T>;
  function fakePaseo(parent: Lookup<{ agent: { provider: string } } | null>, workspace: Lookup<{ projectId: string } | null>) {
    const calls: string[] = [];
    const paseo = {
      agents: { ref: (id: string) => ({ refresh: () => (calls.push(`agent:${id}`), parent()) }) },
      workspaces: { ref: (id: string) => ({ refresh: () => (calls.push(`workspace:${id}`), workspace()) }) },
    } as unknown as Paseo;
    return { paseo, calls };
  }
  const lead = () => Promise.resolve({ agent: { provider: "example-lead" } });
  const inP1 = () => Promise.resolve({ projectId: "p1" });

  function setup(overrides: { routingFile?: string; scopesFile?: string; timeoutMs?: number } = {}) {
    return createRoutingGuard({ routingFile, scopesFile, log: (line) => logs.push(line), ...overrides });
  }

  /** Runs agent.create.before then returns the matching agent.open.before request. */
  function created(guard: ReturnType<typeof setup>, labels: Record<string, string> = {}): OpenRequest {
    const stamped = guard.stampCreation({ config: {}, metadata: {} as Record<string, unknown> });
    assert.ok(stamped);
    return {
      agentId: "child",
      workspaceId: "w1",
      reason: "create",
      purpose: "interactive",
      labels: { [PARENT_AGENT_ID_LABEL]: "parent", ...labels },
      metadata: stamped.metadata,
    };
  }

  test("stampCreation marks new creations and leaves reopened records alone", () => {
    const guard = setup();
    const stamped = guard.stampCreation({ config: { provider: "x" }, env: {}, metadata: { other: 1 } });
    assert.equal(typeof (stamped?.metadata as Record<string, unknown>)[CREATION_MARKER], "string");
    assert.equal(stamped?.metadata.other, 1);
    assert.equal(guard.stampCreation({ config: {}, metadata: { [CREATION_MARKER]: "earlier" } }), undefined);
    assert.equal(guard.stampCreation({ config: {} }), undefined);
  });

  test("stale fresh creation throws; retry with the revision passes", async () => {
    const guard = setup();
    const { paseo, calls } = fakePaseo(lead, inP1);
    await assert.rejects(guard.checkOpen(created(guard), { paseo }), /routing-rev is missing.*set quality/);
    assert.deepEqual(calls, ["workspace:w1", "agent:parent"]);
    await guard.checkOpen(created(guard, { [ROUTING_REV_LABEL]: peerRev }), { paseo });
  });

  test("reopen of a stored agent (marker from its record) is allowed without lookups", async () => {
    const guard = setup();
    const { paseo, calls } = fakePaseo(lead, inP1);
    const request = created(guard);
    await assert.rejects(guard.checkOpen(request, { paseo }));
    calls.length = 0;
    // The same record reopened: agent.create.before keeps its marker, which is no longer pending.
    assert.equal(guard.stampCreation({ config: {}, metadata: { ...request.metadata } }), undefined);
    await guard.checkOpen(request, { paseo });
    assert.deepEqual(calls, []);
  });

  test("non-create reasons return before any I/O", async () => {
    const guard = setup({ scopesFile: join(dir, "nope", "missing.json") });
    const { paseo, calls } = fakePaseo(lead, inP1);
    for (const reason of ["resume", "refresh", "import"]) {
      await guard.checkOpen({ ...created(guard), reason }, { paseo });
    }
    await guard.checkOpen({ ...created(guard), purpose: "history" }, { paseo });
    assert.deepEqual(calls, []);
  });

  test("workspace entry skips the project lookup", async () => {
    await writeFile(scopesFile, renderScopes({ ...EMPTY_SCOPES, projects: { p1: { set: "economy", enforce: true } }, workspaces: { w1: { set: "quality", enforce: true } } }));
    const guard = setup();
    const { paseo, calls } = fakePaseo(lead, inP1);
    await assert.rejects(guard.checkOpen(created(guard), { paseo }), /Scope workspace w1/);
    assert.deepEqual(calls, ["agent:parent"]);
    await writeFile(scopesFile, renderScopes(enforcing));
  });

  const failOpen: Array<[string, () => { guard: ReturnType<typeof setup>; paseo: Paseo }]> = [
    ["missing scopes file", () => ({ guard: setup({ scopesFile: join(dir, "absent.json") }), paseo: fakePaseo(lead, inP1).paseo })],
    ["invalid scopes file", () => ({ guard: setup({ scopesFile: routingFile }), paseo: fakePaseo(lead, inP1).paseo })],
    ["unreadable routing file", () => ({ guard: setup({ routingFile: join(dir, "absent.md") }), paseo: fakePaseo(lead, inP1).paseo })],
    ["unparseable routing file", () => ({ guard: setup({ routingFile: scopesFile }), paseo: fakePaseo(lead, inP1).paseo })],
    ["workspace lookup fails", () => ({ guard: setup(), paseo: fakePaseo(lead, () => Promise.reject(new Error("ipc down"))).paseo })],
    ["workspace unknown", () => ({ guard: setup(), paseo: fakePaseo(lead, () => Promise.resolve(null)).paseo })],
    ["parent lookup fails", () => ({ guard: setup(), paseo: fakePaseo(() => Promise.reject(new Error("no agent")), inP1).paseo })],
    ["parent not found", () => ({ guard: setup(), paseo: fakePaseo(() => Promise.resolve(null), inP1).paseo })],
    ["parent lookup hangs", () => ({ guard: setup({ timeoutMs: 50 }), paseo: fakePaseo(() => new Promise(() => {}), inP1).paseo })],
  ];
  for (const [name, make] of failOpen) {
    test(`fails open: ${name}`, async () => {
      const { guard, paseo } = make();
      const started = Date.now();
      await guard.checkOpen(created(guard), { paseo });
      assert.ok(Date.now() - started < 1000);
    });
  }
});
