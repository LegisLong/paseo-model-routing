/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { run, type Env } from "../cli/routing";
import { guardDecision, PARENT_AGENT_ID_LABEL, ROUTING_REV_LABEL } from "../server/guard";
import { parseRouting } from "../server/routing-file";
import { EMPTY_SCOPES, renderScopes, roleView } from "../server/scopes-file";
import type { Scopes } from "../shared/scopes";
import { ROUTING_MD } from "./fixture";

let dir: string;
let env: Env;
const scopes: Scopes = {
  ...EMPTY_SCOPES,
  projects: { p1: { set: "quality", enforce: true } },
  workspaces: {},
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "routing-cli-"));
  env = {
    PASEO_MODEL_ROUTING_FILE: join(dir, "model-routing.md"),
    PASEO_MODEL_ROUTING_SCOPES_FILE: join(dir, "model-routing-scopes.json"),
  };
  await writeFile(env.PASEO_MODEL_ROUTING_FILE!, ROUTING_MD, "utf8");
  await writeFile(env.PASEO_MODEL_ROUTING_SCOPES_FILE!, renderScopes(scopes), "utf8");
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("routing resolve", () => {
  test("returns one set, role-filtered, with the guard's revision and no other sets", async () => {
    const result = await run(["resolve", "--workspace", "w1", "--project", "p1", "--role", "peer"], env);
    assert.equal(result.code, 0);
    const out = result.out as { set: string; rev: string; routes: { tier: string }[] };
    assert.equal(out.set, "quality");
    assert.deepEqual(out.routes.map((route) => route.tier), ["routine", "light"]);
    const text = JSON.stringify(result.out);
    assert.ok(!text.includes("economy"), "output must not name other sets");
    const routing = parseRouting(ROUTING_MD);
    const rev = roleView(routing, "quality", "peer")!.revision;
    assert.equal(out.rev, rev);
    // The guard accepts exactly the revision the CLI printed.
    const decision = guardDecision({
      request: {
        reason: "create",
        purpose: "interactive",
        workspaceId: "w1",
        labels: { [PARENT_AGENT_ID_LABEL]: "parent", [ROUTING_REV_LABEL]: rev },
      },
      fresh: true,
      scopes,
      routing,
      projectId: "p1",
      parentProvider: "example-lead",
    });
    assert.equal(decision.kind, "allow");
  });

  test("unresolved without a target, and for a workspace with no entry and no project", async () => {
    const none = await run(["resolve", "--role", "peer"], env);
    assert.equal(none.code, 1);
    assert.equal((none.out as { error: string }).error, "unresolved");
    const unknown = await run(["resolve", "--workspace", "w9", "--role", "peer"], env);
    assert.equal(unknown.code, 1);
    assert.equal((unknown.out as { error: string }).error, "unresolved");
  });
});

describe("routing set-route", () => {
  test("stale revision is refused and nothing is written; current revision applies", async () => {
    const path = env.PASEO_MODEL_ROUTING_FILE!;
    const before = await readFile(path, "utf8");
    const stale = await run(
      ["set-route", "quality", "routine", "--provider", "example-peer", "--model", "model-small-5-5", "--effort", "low", "--routing-rev", "0000"],
      env,
    );
    assert.equal(stale.code, 1);
    assert.equal((stale.out as { error: string }).error, "stale");
    assert.equal(await readFile(path, "utf8"), before);

    const { revisions } = (await run(["resolve", "--workspace", "w1", "--project", "p1", "--role", "peer"], env)).out as {
      revisions: { routing: string };
    };
    const ok = await run(
      ["set-route", "quality", "routine", "--provider", "example-peer", "--model", "model-small-5-5", "--effort", "low", "--routing-rev", revisions.routing],
      env,
    );
    assert.equal(ok.code, 0);
    const after = await run(["resolve", "--workspace", "w1", "--project", "p1", "--role", "peer"], env);
    const routine = (after.out as { routes: { tier: string; model: string; effort: string }[] }).routes.find((r) => r.tier === "routine");
    assert.deepEqual({ model: routine?.model, effort: routine?.effort }, { model: "model-small-5-5", effort: "low" });
    assert.notEqual((after.out as { rev: string }).rev, roleView(parseRouting(ROUTING_MD), "quality", "peer")!.revision);
  });

  test("without --note the existing note of the row is kept", async () => {
    const path = env.PASEO_MODEL_ROUTING_FILE!;
    const { revisions } = (await run(["resolve", "--workspace", "w1", "--project", "p1", "--role", "peer"], env)).out as {
      revisions: { routing: string };
    };
    const before = parseRouting(await readFile(path, "utf8"));
    const oldNote = before.presets.find((p) => p.name === "quality")!.routes.find((r) => r.tier === "routine")!.note;
    const result = await run(
      ["set-route", "quality", "routine", "--provider", "example-peer", "--model", "model-large-5-5", "--effort", "medium", "--routing-rev", revisions.routing],
      env,
    );
    assert.equal(result.code, 0);
    const after = parseRouting(await readFile(path, "utf8"));
    assert.equal(after.presets.find((p) => p.name === "quality")!.routes.find((r) => r.tier === "routine")!.note, oldNote);
  });
});
