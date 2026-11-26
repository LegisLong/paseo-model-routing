/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { Routing } from "../shared/routing";
import type { Scopes } from "../shared/scopes";
import { assignRole, MISSING_SCOPES_REVISION } from "../shared/scopes";
import { parseRouting } from "../server/routing-file";
import {
  EMPTY_SCOPES,
  readScopesFile,
  resolveEffective,
  roleView,
  writeScopesFile,
} from "../server/scopes-file";
import { ROUTING_MD } from "./fixture";

const routing = parseRouting(ROUTING_MD);

function scopes(partial: Partial<Scopes>): Scopes {
  return { ...EMPTY_SCOPES, ...partial };
}

function edit(base: Routing, set: string, tier: string, patch: Partial<Routing["presets"][number]["routes"][number]>): Routing {
  return {
    ...base,
    presets: base.presets.map((preset) =>
      preset.name !== set
        ? preset
        : { ...preset, routes: preset.routes.map((route) => (route.tier === tier ? { ...route, ...patch } : route)) },
    ),
  };
}

describe("resolveEffective", () => {
  test("missing scopes: global default, not enforced", () => {
    assert.deepEqual(resolveEffective(null, routing, "w1", "p1"), {
      set: "economy",
      scope: { kind: "global", id: null },
      enforced: false,
      error: null,
    });
  });

  test("workspace entry beats project entry beats global", () => {
    const table = scopes({
      projects: { p1: { set: "quality", enforce: true } },
      workspaces: { w1: { set: "economy", enforce: true } },
    });
    assert.deepEqual(resolveEffective(table, routing, "w1", "p1").scope, { kind: "workspace", id: "w1" });
    assert.deepEqual(resolveEffective(table, routing, "w2", "p1"), {
      set: "quality",
      scope: { kind: "project", id: "p1" },
      enforced: true,
      error: null,
    });
    assert.equal(resolveEffective(table, routing, "w3", "p9").scope.kind, "global");
  });

  test("workspace entry with enforce:false opts out of an enforcing project", () => {
    const table = scopes({
      projects: { p1: { set: "quality", enforce: true } },
      workspaces: { w1: { set: "quality", enforce: false } },
    });
    const effective = resolveEffective(table, routing, "w1", "p1");
    assert.equal(effective.enforced, false);
    assert.equal(effective.scope.kind, "workspace");
  });

  test("a scope naming a missing set is reported and never enforced", () => {
    const table = scopes({ workspaces: { w1: { set: "gone", enforce: true } } });
    const effective = resolveEffective(table, routing, "w1", null);
    assert.equal(effective.enforced, false);
    assert.match(effective.error ?? "", /gone/);
  });

  test("global enforce flag is honoured only when no entry wins", () => {
    const table = scopes({ global: { enforce: true }, workspaces: { w1: { set: "economy", enforce: false } } });
    assert.equal(resolveEffective(table, routing, "w2", null).enforced, true);
    assert.equal(resolveEffective(table, routing, "w1", null).enforced, false);
  });
});

describe("roles and revisions", () => {
  test("without roles the default suffix rules apply, as in 0.1.0", () => {
    const role = (provider: string | null) => assignRole(undefined, { provider })?.role ?? null;
    assert.equal(role("example-supervisor"), "lead");
    assert.equal(role("example-lead"), "peer");
    assert.equal(role("example-peer"), null);
    assert.equal(role("example"), null);
    assert.equal(role(null), null);
  });

  test("peer view excludes the lead row; lead view is only the lead row", () => {
    assert.deepEqual(roleView(routing, "quality", "peer")?.routes.map((route) => route.tier), ["routine", "light"]);
    assert.deepEqual(roleView(routing, "quality", "lead")?.routes.map((route) => route.tier), ["lead"]);
    assert.equal(roleView(routing, "economy", "lead"), null);
    assert.equal(roleView(routing, "missing", "peer"), null);
  });

  test("unrelated edits keep the revision", () => {
    const peer = roleView(routing, "quality", "peer")!.revision;
    const lead = roleView(routing, "quality", "lead")!.revision;
    const otherPreset = edit(routing, "economy", "routine", { effort: "high" });
    const summary = { ...routing, presets: routing.presets.map((preset) => ({ ...preset, summary: "changed" })) };
    const active = { ...routing, active: "quality" };
    const reordered = {
      ...routing,
      presets: routing.presets.map((preset) => ({ ...preset, routes: [...preset.routes].reverse() })),
    };
    for (const next of [otherPreset, summary, active, reordered]) {
      assert.equal(roleView(next, "quality", "peer")!.revision, peer);
      assert.equal(roleView(next, "quality", "lead")!.revision, lead);
    }
    // A lead-row edit does not move the peer view, and a peer-row edit does not move the lead view.
    assert.equal(roleView(edit(routing, "quality", "lead", { model: "x" }), "quality", "peer")!.revision, peer);
    assert.equal(roleView(edit(routing, "quality", "light", { model: "x" }), "quality", "lead")!.revision, lead);
  });

  test("role-view edits change the revision", () => {
    const peer = roleView(routing, "quality", "peer")!.revision;
    const lead = roleView(routing, "quality", "lead")!.revision;
    for (const patch of [{ provider: "x" }, { model: "x" }, { effort: "low" }, { note: "x" }]) {
      assert.notEqual(roleView(edit(routing, "quality", "routine", patch), "quality", "peer")!.revision, peer);
      assert.notEqual(roleView(edit(routing, "quality", "lead", patch), "quality", "lead")!.revision, lead);
    }
    // Same rows under another set name: a different revision, since the set itself changed.
    const renamed = { ...routing, presets: routing.presets.map((preset) => ({ ...preset, name: preset.name + "2" })) };
    assert.notEqual(roleView(renamed, "quality2", "peer")!.revision, peer);
  });
});

describe("scopes file", () => {
  let dir = "";
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("missing file reads as empty; compare-and-swap create and update", async () => {
    dir = await mkdtemp(join(tmpdir(), "model-routing-scopes-"));
    const path = join(dir, "model-routing-scopes.json");
    const missing = await readScopesFile(path);
    assert.deepEqual(missing, { exists: false, revision: MISSING_SCOPES_REVISION, scopes: EMPTY_SCOPES, error: null });

    const first = scopes({ workspaces: { w1: { set: "quality", enforce: true } } });
    await assert.rejects(writeScopesFile(path, "stale", first), /changed since it was loaded/);
    await writeScopesFile(path, MISSING_SCOPES_REVISION, first);
    const created = await readScopesFile(path);
    assert.deepEqual(created.scopes, first);
    assert.notEqual(created.revision, MISSING_SCOPES_REVISION);

    // A writer holding the old revision loses.
    await assert.rejects(writeScopesFile(path, MISSING_SCOPES_REVISION, EMPTY_SCOPES), /changed since/);
    const second = scopes({ projects: { p1: { set: "economy", enforce: false } } });
    await writeScopesFile(path, created.revision, second);
    assert.deepEqual((await readScopesFile(path)).scopes, second);
    assert.match(await readFile(path, "utf8"), /^\{\n  "version": 1,/);
  });

  test("invalid content is reported, not thrown", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "{ not json");
    const bad = await readScopesFile(path);
    assert.equal(bad.scopes, null);
    assert.match(bad.error ?? "", /not JSON/);
    await writeFile(path, JSON.stringify({ ...EMPTY_SCOPES, extra: 1 }));
    assert.match((await readScopesFile(path)).error ?? "", /invalid/);
  });
});
