/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { defaultRoutingFile, paseoHome } from "../server/paths";
import { parseRouting, starterRouting } from "../server/routing-file";
import { MISSING_ROUTING_REVISION } from "../shared/routing";
import { routingPath, scopesPath } from "../cli/routing";

// The daemon's home is a nested directory that does not exist yet: creation must make it.
const dir = await mkdtemp(join(tmpdir(), "model-routing-first-run-"));
const home = join(dir, "daemon-home");
process.env.PASEO_HOME = home;
delete process.env.PASEO_MODEL_ROUTING_FILE;
delete process.env.PASEO_MODEL_ROUTING_SCOPES_FILE;
const handlers = await import("../server/handlers");

const context = {
  paseo: { providers: { snapshot: async () => ({ entries: [] }) } },
} as unknown as PluginHandlerContext;

describe("default paths follow the daemon's Paseo home", () => {
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("PASEO_HOME wins; without it the rule is ~/.paseo; ~ is expanded", () => {
    assert.equal(paseoHome({ PASEO_HOME: home }), resolve(home));
    assert.equal(paseoHome({}), join(homedir(), ".paseo"));
    assert.equal(paseoHome({ PASEO_HOME: "" }), join(homedir(), ".paseo"));
    assert.equal(paseoHome({ PASEO_HOME: "~/other" }), join(homedir(), "other"));
    assert.equal(defaultRoutingFile({ PASEO_HOME: home }), join(resolve(home), "model-routing.md"));
  });

  test("server and CLI use PASEO_HOME; the explicit variables still win", async () => {
    assert.equal(handlers.ROUTING_FILE, join(resolve(home), "model-routing.md"));
    assert.equal(handlers.SCOPES_FILE, join(resolve(home), "model-routing-scopes.json"));
    const explicit = join(dir, "elsewhere.md");
    assert.equal(routingPath({ PASEO_HOME: home }), join(resolve(home), "model-routing.md"));
    assert.equal(scopesPath({ PASEO_HOME: home }), join(resolve(home), "model-routing-scopes.json"));
    assert.equal(routingPath({ PASEO_HOME: home, PASEO_MODEL_ROUTING_FILE: explicit }), explicit);
    assert.equal(scopesPath({ PASEO_HOME: home, PASEO_MODEL_ROUTING_FILE: explicit }), join(dir, "model-routing-scopes.json"));
  });

  test("a missing routing file reads as missing, not as an error", async () => {
    const state = await handlers.readRouting({}, context);
    assert.equal(state.missing, true);
    assert.equal(state.routing, null);
    assert.equal(state.parseError, null);
    assert.equal(state.revision, MISSING_ROUTING_REVISION);
    assert.equal(state.path, handlers.ROUTING_FILE);
  });

  test("the starting file parses, names no invented provider, and is created once", async () => {
    const text = starterRouting();
    const routing = parseRouting(text);
    assert.equal(routing.active, "default");
    assert.deepEqual(
      routing.presets.map((preset) => [preset.name, preset.routes.map((route) => [route.tier, route.provider])]),
      [["default", [["routine", ""]]]],
    );

    const created = await handlers.createRouting({}, context);
    assert.equal(created.missing, undefined);
    assert.equal(created.routing?.active, "default");
    assert.equal(await readFile(handlers.ROUTING_FILE, "utf8"), text);

    // A second create, or a file the owner made meanwhile, is never overwritten.
    await writeFile(handlers.ROUTING_FILE, "owner content", "utf8");
    await assert.rejects(handlers.createRouting({}, context), /already exists/);
    assert.equal(await readFile(handlers.ROUTING_FILE, "utf8"), "owner content");
  });

  test("a save after create writes to the file under PASEO_HOME", async () => {
    await rm(handlers.ROUTING_FILE);
    const created = await handlers.createRouting({}, context);
    assert.ok(created.routing);
    const next = structuredClone(created.routing);
    next.presets[0].routes[0] = { tier: "routine", provider: "example-peer", model: "m", effort: "low", note: "x" };
    const saved = await handlers.saveRouting({ revision: created.revision, routing: next }, context);
    assert.equal(saved.routing?.presets[0].routes[0].provider, "example-peer");
    assert.match(await readFile(join(resolve(home), "model-routing.md"), "utf8"), /example-peer/);
  });
});
