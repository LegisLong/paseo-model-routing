/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { MISSING_SCOPES_REVISION } from "../shared/scopes";
import { revisionOf } from "../server/scopes-file";
import { ROUTING_MD } from "./fixture";

// handlers.ts reads its paths from the environment at import time: point them at temp copies.
const dir = await mkdtemp(join(tmpdir(), "model-routing-handlers-"));
const routingFile = join(dir, "model-routing.md");
process.env.PASEO_MODEL_ROUTING_FILE = routingFile;
delete process.env.PASEO_MODEL_ROUTING_SCOPES_FILE;
const handlers = await import("../server/handlers");

const context = {
  paseo: {
    providers: { snapshot: async () => ({ entries: [] }) },
    projects: { list: async () => ({ projects: [{ projectId: "p1", projectDisplayName: "One", projectRootPath: "C:/one" }] }) },
    workspaces: {
      list: async () => ({
        entries: [
          { id: "w1", name: "main", projectId: "p1", workspaceDirectory: "C:/one" },
          { id: "w2", name: "side", projectId: "p1", workspaceDirectory: "C:/one-side" },
        ],
        pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      }),
      ref: (id: string) => ({ refresh: async () => ({ id, projectId: "p1" }) }),
    },
  },
} as unknown as PluginHandlerContext;

async function routingRevision(): Promise<string> {
  return revisionOf(await readFile(routingFile));
}

describe("handlers", () => {
  before(async () => {
    await writeFile(routingFile, ROUTING_MD);
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("scopes file defaults beside the routing file", () => {
    assert.equal(handlers.SCOPES_FILE, join(dir, "model-routing-scopes.json"));
  });

  test("routing.read waits for provider discovery and reports catalogues still loading", async () => {
    const entries = [
      { provider: "example-peer", label: "Example Peer", enabled: true, status: "ready",
        models: [{ id: "model-small-5.5", label: "Small", thinkingOptions: [{ id: "low", label: "low" }] }] },
      { provider: "slow", enabled: true, status: "loading" },
      { provider: "off", enabled: false, status: "unavailable" },
    ];
    let waited: unknown = null;
    const waiting = {
      paseo: {
        ...context.paseo,
        providers: {
          waitForReady: async (options: unknown) => ((waited = options), { entries }),
          snapshot: async () => assert.fail("snapshot used although waitForReady answered"),
        },
      },
    } as unknown as PluginHandlerContext;
    const state = await handlers.readRouting({}, waiting);
    assert.deepEqual(waited, { timeoutMs: 5000 });
    assert.deepEqual(
      state.providers.map((p) => [p.id, p.modelsStatus, p.models.map((m) => m.id)]),
      [["example-peer", "ready", ["model-small-5.5"]], ["off", "unavailable", []], ["slow", "loading", []]],
    );
    // A wait that times out (or a host without waitForReady) falls back to the plain snapshot.
    const timedOut = {
      paseo: {
        ...context.paseo,
        providers: { waitForReady: async () => { throw new Error("Timed out"); }, snapshot: async () => ({ entries }) },
      },
    } as unknown as PluginHandlerContext;
    assert.equal((await handlers.readRouting({}, timedOut)).providers.length, 3);
  });

  test("read without a scopes file: global default everywhere", async () => {
    const state = await handlers.readScopes({}, context);
    assert.equal(state.exists, false);
    assert.equal(state.revision, MISSING_SCOPES_REVISION);
    assert.equal(state.globalSet, "economy");
    assert.deepEqual(state.sets, ["economy", "quality"]);
    assert.deepEqual(state.workspaces.map((workspace) => workspace.effective.set), ["economy", "economy"]);
    assert.equal(state.listError, null);
  });

  test("save validates sets and global enforcement, then resolves per workspace", async () => {
    const base = { version: 1 as const, global: { enforce: false }, projects: {}, workspaces: {} };
    await assert.rejects(
      handlers.saveScopes({ revision: MISSING_SCOPES_REVISION, scopes: { ...base, workspaces: { w1: { set: "nope", enforce: true } } } }, context),
      /Unknown set: workspace:w1 uses `nope`/,
    );
    await assert.rejects(
      handlers.saveScopes({ revision: MISSING_SCOPES_REVISION, scopes: { ...base, global: { enforce: true } } }, context),
      /Global enforcement is off/,
    );
    const state = await handlers.saveScopes(
      {
        revision: MISSING_SCOPES_REVISION,
        scopes: { ...base, projects: { p1: { set: "quality", enforce: true } }, workspaces: { w2: { set: "economy", enforce: false } } },
      },
      context,
    );
    assert.deepEqual(
      state.workspaces.map((workspace) => [workspace.id, workspace.effective.set, workspace.effective.scope.kind, workspace.effective.enforced]),
      [["w1", "quality", "project", true], ["w2", "economy", "workspace", false]],
    );
    const resolved = await handlers.resolveScope({ workspaceId: "w1" }, context);
    assert.equal(resolved.projectId, "p1");
    assert.equal(resolved.views?.lead?.routes[0].provider, "example-lead");
    assert.deepEqual(resolved.views?.peer?.routes.map((route) => route.tier), ["routine", "light"]);
    await assert.rejects(handlers.saveScopes({ revision: MISSING_SCOPES_REVISION, scopes: base }, context), /changed since/);
  });

  test("routing.save cannot drop a referenced set; rename moves the references", async () => {
    const current = await handlers.readRouting({}, context);
    const routing = current.routing!;
    const without = { ...routing, presets: routing.presets.filter((preset) => preset.name !== "quality") };
    await assert.rejects(handlers.saveRouting({ revision: current.revision, routing: without }, context), /Set `quality` is still used by project:p1\./);

    const renamed = await handlers.manageSet({ revision: current.revision, op: { kind: "rename", from: "quality", to: "best" } }, context);
    assert.deepEqual(renamed.routing?.presets.map((preset) => preset.name), ["economy", "best"]);
    const scopes = await handlers.readScopes({}, context);
    assert.equal(scopes.scopes?.projects.p1.set, "best");
    await assert.rejects(
      handlers.manageSet({ revision: await routingRevision(), op: { kind: "delete", name: "best" } }, context),
      /used by project:p1/,
    );
    await assert.rejects(
      handlers.manageSet({ revision: current.revision, op: { kind: "delete", name: "best" } }, context),
      /changed since it was loaded/,
    );
    const duplicated = await handlers.manageSet(
      { revision: await routingRevision(), op: { kind: "duplicate", from: "best", name: "trial" } },
      context,
    );
    assert.deepEqual(duplicated.routing?.presets.map((preset) => preset.name), ["economy", "best", "trial"]);
    const deleted = await handlers.manageSet({ revision: await routingRevision(), op: { kind: "delete", name: "trial" } }, context);
    assert.deepEqual(deleted.routing?.presets.map((preset) => preset.name), ["economy", "best"]);
  });
});
