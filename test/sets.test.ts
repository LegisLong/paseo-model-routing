/// <reference types="node" />
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Scopes } from "../shared/scopes";
import { applyRouting, parseRouting } from "../server/routing-file";
import { EMPTY_SCOPES } from "../server/scopes-file";
import { applySetOp, assertNoReferencedRemoval } from "../server/sets";
import { ROUTING_MD } from "./fixture";

const routing = parseRouting(ROUTING_MD);
const scopes: Scopes = {
  ...EMPTY_SCOPES,
  projects: { p1: { set: "quality", enforce: true } },
  workspaces: { w1: { set: "quality", enforce: false }, w2: { set: "economy", enforce: true } },
};

describe("md round trip", () => {
  test("rewriting untouched presets is byte-identical", () => {
    assert.equal(applyRouting(ROUTING_MD, routing), ROUTING_MD);
  });

  test("duplicate keeps every existing line, Quick routing included", () => {
    const { routing: next } = applySetOp(routing, { kind: "duplicate", from: "quality", name: "trial" }, scopes);
    const text = applyRouting(ROUTING_MD, next);
    const before = ROUTING_MD.split("\r\n");
    const after = text.split("\r\n");
    assert.ok(after.length > before.length);
    let cursor = 0;
    for (const line of before) {
      cursor = after.indexOf(line, cursor);
      assert.notEqual(cursor, -1, `line kept in order: ${line}`);
      cursor += 1;
    }
    assert.deepEqual(parseRouting(text).presets.find((preset) => preset.name === "trial")?.routes,
      routing.presets.find((preset) => preset.name === "quality")?.routes);
  });
});

describe("applySetOp", () => {
  test("create needs a new valid name", () => {
    const routes = [{ tier: "routine", provider: "example-peer", model: "m", effort: "high", note: "" }];
    const created = applySetOp(routing, { kind: "create", name: "fresh", summary: "", routes }, null);
    assert.deepEqual(created.routing.presets.at(-1), { name: "fresh", summary: "", routes });
    assert.equal(created.scopes, null);
    assert.throws(() => applySetOp(routing, { kind: "create", name: "economy", summary: "", routes }, null), /already exists/);
    assert.throws(() => applySetOp(routing, { kind: "create", name: "a b", summary: "", routes }, null), /Bad set name/);
  });

  test("rename rewrites scope entries and the active line explicitly", () => {
    const renamed = applySetOp(routing, { kind: "rename", from: "quality", to: "best" }, scopes);
    assert.deepEqual(renamed.routing.presets.map((preset) => preset.name), ["economy", "best"]);
    assert.equal(renamed.scopes?.projects.p1.set, "best");
    assert.equal(renamed.scopes?.workspaces.w1.set, "best");
    assert.deepEqual(renamed.scopes?.workspaces.w2, { set: "economy", enforce: true });

    const active = applySetOp(routing, { kind: "rename", from: "economy", to: "cheap" }, EMPTY_SCOPES);
    assert.equal(active.routing.active, "cheap");
    assert.equal(active.scopes, null);
    assert.throws(() => applySetOp(routing, { kind: "rename", from: "quality", to: "x" }, null), /unreadable/);
  });

  test("delete refuses referenced sets and the global default", () => {
    assert.throws(() => applySetOp(routing, { kind: "delete", name: "quality" }, scopes), {
      message: "Set `quality` is still used by project:p1 and workspace:w1. Reassign them first.",
    });
    assert.throws(() => applySetOp(routing, { kind: "delete", name: "economy" }, EMPTY_SCOPES), /global default/);
    assert.throws(() => applySetOp(routing, { kind: "delete", name: "quality" }, null), /unreadable/);
    const deleted = applySetOp(routing, { kind: "delete", name: "quality" }, EMPTY_SCOPES);
    assert.deepEqual(deleted.routing.presets.map((preset) => preset.name), ["economy"]);
  });

  test("a whole-file save cannot drop a referenced set", () => {
    const without = { ...routing, presets: routing.presets.filter((preset) => preset.name !== "quality") };
    assert.throws(() => assertNoReferencedRemoval(routing, without, scopes), /Set `quality` is still used by/);
    assert.doesNotThrow(() => assertNoReferencedRemoval(routing, without, EMPTY_SCOPES));
    assert.doesNotThrow(() => assertNoReferencedRemoval(routing, routing, null));
    assert.throws(() => assertNoReferencedRemoval(routing, without, null), /unreadable/);
  });
});
