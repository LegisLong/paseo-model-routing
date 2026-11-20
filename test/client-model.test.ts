/// <reference types="node" />
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Routing } from "../shared/routing";
import type { EffectiveRouting, Scopes, ScopesState } from "../shared/scopes";
import {
  addRoute,
  assignSet,
  displayError,
  draftEffective,
  draftStatus,
  effectiveParts,
  errorText,
  groupByProject,
  INHERIT,
  isStaleError,
  modelEntry,
  nameProblem,
  nameScopeRefs,
  projectEffective,
  providersLoading,
  removeRoute,
  scopeChanged,
  scopeRefName,
  setEnforce,
  setInUseText,
  setUsage,
  staleSaveMessage,
  tierProblem,
  unlistedEntries,
} from "../client/scope-model";

const empty: Scopes = { version: 1, global: { enforce: false }, projects: {}, workspaces: {} };
const effective = (patch: Partial<EffectiveRouting> = {}): EffectiveRouting => ({
  set: "economy",
  scope: { kind: "global", id: null },
  enforced: false,
  error: null,
  ...patch,
});

function ws(id: string, projectId: string, name: string, directory: string | null = null) {
  return { id, projectId, name, directory, effective: effective() };
}

const lists: Pick<ScopesState, "projects" | "workspaces"> = {
  projects: [
    { id: "p2", name: "Zeta", rootPath: "C:/z" },
    { id: "p1", name: "Alpha", rootPath: "C:/a" },
    { id: "p3", name: "Empty", rootPath: "C:/e" },
  ],
  workspaces: [ws("w2", "p1", "beta"), ws("w1", "p1", "alpha"), ws("w3", "p2", "main", "C:/z/main"), ws("w9", "pX", "orphan")],
};

describe("draftStatus", () => {
  const base = { revision: "r1", value: { a: 1 } };
  test("first load adopts the server copy", () => {
    assert.deepEqual(draftStatus(null, { a: 0 }, base), { dirty: false, stale: false, follow: true });
  });
  test("clean draft follows a changed file", () => {
    assert.deepEqual(draftStatus(base, { a: 1 }, { revision: "r2", value: { a: 2 } }), {
      dirty: false,
      stale: false,
      follow: true,
    });
  });
  test("edits survive a changed file and are flagged stale", () => {
    assert.deepEqual(draftStatus(base, { a: 5 }, { revision: "r2", value: { a: 2 } }), {
      dirty: true,
      stale: true,
      follow: false,
    });
  });
  test("edits with an unchanged file are dirty, not stale", () => {
    assert.deepEqual(draftStatus(base, { a: 5 }, base), { dirty: true, stale: false, follow: false });
  });
  test("a null draft against a null file is clean", () => {
    assert.equal(draftStatus({ revision: "x", value: null }, null, undefined).dirty, false);
  });
});

describe("stale errors", () => {
  test("recognises the server's stale messages for both files", () => {
    assert.ok(isStaleError("model-routing.md changed since it was loaded. Reload and apply the change again."));
    assert.ok(isStaleError("model-routing-scopes.json changed since it was loaded. Reload and apply the change again."));
    assert.ok(!isStaleError("Cannot delete `economy`: it is the global default (active:)."));
  });
});

describe("scope assignments", () => {
  test("assigning creates a non-enforcing entry; changing the set keeps enforce", () => {
    const a = assignSet(empty, "workspaces", "w1", "quality");
    assert.deepEqual(a.workspaces.w1, { set: "quality", enforce: false });
    const b = assignSet(setEnforce(a, "workspaces", "w1", true), "workspaces", "w1", "economy");
    assert.deepEqual(b.workspaces.w1, { set: "economy", enforce: true });
  });
  test("inherit removes only that entry and does not mutate the input", () => {
    const a = assignSet(assignSet(empty, "projects", "p1", "quality"), "workspaces", "w1", "economy");
    const b = assignSet(a, "workspaces", "w1", INHERIT);
    assert.deepEqual(b.workspaces, {});
    assert.deepEqual(b.projects, { p1: { set: "quality", enforce: false } });
    assert.deepEqual(a.workspaces, { w1: { set: "economy", enforce: false } });
  });
  test("enforce on a missing entry is a no-op", () => {
    assert.equal(setEnforce(empty, "projects", "p1", true), empty);
  });
  test("scopeChanged looks at the workspace and its project only", () => {
    const draft = assignSet(empty, "projects", "p1", "quality");
    assert.ok(scopeChanged(empty, draft, "w1", "p1"));
    assert.ok(!scopeChanged(empty, draft, "w3", "p2"));
  });
});

describe("effective wording", () => {
  test("names the set and where it comes from", () => {
    assert.deepEqual(effectiveParts(effective()), { set: "economy", from: "from global" });
    assert.deepEqual(effectiveParts(effective({ set: "quality", scope: { kind: "workspace", id: "w1" } })), {
      set: "quality",
      from: "from workspace",
    });
    assert.equal(effectiveParts(effective({ set: null })).set, "unknown");
  });
  test("a project inherits the global default until it has an entry", () => {
    assert.deepEqual(projectEffective(empty, "p1", "economy"), { set: "economy", kind: "global" });
    assert.deepEqual(projectEffective(assignSet(empty, "projects", "p1", "quality"), "p1", "economy"), {
      set: "quality",
      kind: "project",
    });
  });
  test("set usage counts project and workspace entries", () => {
    const scopes = assignSet(assignSet(empty, "projects", "p1", "quality"), "workspaces", "w1", "quality");
    assert.equal(setUsage(scopes, "quality"), 2);
    assert.equal(setUsage(scopes, "economy"), 0);
    assert.equal(setUsage(null, "quality"), 0);
  });
});

describe("refusal text", () => {
  test("drops the host's transport prefix and suffix", () => {
    assert.equal(
      displayError(
        "Request failed: Cannot delete `economy`: it is the global default (active:). Pick another first. requestType=plugin.rpc.invoke.request code=handler_error",
      ),
      "Cannot delete `economy`: it is the global default (active:). Pick another first.",
    );
    assert.equal(displayError("Plain message."), "Plain message.");
    assert.equal(errorText(new Error("Request failed: x requestType=a code=b")), "x");
  });
  test("stale detection still works on the cleaned text", () => {
    assert.ok(
      isStaleError(
        errorText(new Error("Request failed: model-routing.md changed since it was loaded. Reload. requestType=r code=c")),
      ),
    );
  });
  test("a stale save says which file, that nothing was written, the draft was kept, and how to proceed", () => {
    const text = staleSaveMessage("model-routing-scopes.json changed since it was loaded. Reload and apply the change again.", true);
    assert.match(text, /^model-routing-scopes\.json changed on disk/);
    assert.match(text, /nothing was written/);
    assert.match(text, /edits are kept/);
    assert.match(text, /Reload and discard my edits/);
    const op = staleSaveMessage("model-routing.md changed since it was loaded.", false);
    assert.match(op, /^model-routing\.md changed/);
    assert.doesNotMatch(op, /edits are kept/);
  });
  test("scope references read as project and workspace names, never ids", () => {
    const twins = { ...lists, workspaces: [...lists.workspaces, ws("w4", "p2", "beta")] };
    assert.equal(scopeRefName("project:p1", lists), "project Alpha");
    assert.equal(scopeRefName("workspace:w1", lists), "workspace alpha");
    assert.equal(scopeRefName("workspace:w2", twins), "workspace beta (project Alpha)");
    assert.equal(scopeRefName("workspace:wks-example-1", lists), "a workspace the daemon no longer lists");
    assert.equal(scopeRefName("project:gone", lists), "a project the daemon no longer lists");
    assert.equal(
      nameScopeRefs("Set `quality` is still used by project:p1 and workspace:w404. Reassign them first.", lists),
      "Set `quality` is still used by project Alpha and a workspace the daemon no longer lists. Reassign them first.",
    );
  });
  test("deleting a set in use is refused with names", () => {
    const scopes = assignSet(assignSet(assignSet(empty, "workspaces", "w2", "trial"), "projects", "p1", "trial"), "workspaces", "w3", "x");
    assert.equal(
      setInUseText(scopes, "trial", lists),
      "Set `trial` is still used by project Alpha and workspace beta. Reassign them first.",
    );
    assert.equal(
      setInUseText(assignSet(empty, "workspaces", "w1", "trial"), "trial", lists),
      "Set `trial` is still used by workspace alpha. Reassign it first.",
    );
    assert.equal(setInUseText(scopes, "unused", lists), null);
    assert.equal(setInUseText(null, "trial", lists), null);
  });
});

describe("draft effective", () => {
  const sets = ["economy", "quality"];
  test("follows the draft: workspace entry > project entry > global, enforcement from the winner", () => {
    const project = setEnforce(assignSet(empty, "projects", "p1", "quality"), "projects", "p1", true);
    assert.deepEqual(draftEffective(project, "economy", sets, { id: "w1", projectId: "p1" }), {
      set: "quality",
      scope: { kind: "project", id: "p1" },
      enforced: true,
      error: null,
    });
    const optOut = assignSet(project, "workspaces", "w1", "economy");
    const view = draftEffective(optOut, "economy", sets, { id: "w1", projectId: "p1" });
    assert.equal(view.scope.kind, "workspace");
    assert.equal(view.enforced, false);
    assert.deepEqual(draftEffective(empty, "quality", sets, { id: "w1", projectId: "p1" }).set, "quality");
  });
  test("an entry naming a missing set reports an error and is not enforced", () => {
    const scopes = setEnforce(assignSet(empty, "workspaces", "w1", "gone"), "workspaces", "w1", true);
    const view = draftEffective(scopes, "economy", sets, { id: "w1", projectId: "p1" });
    assert.equal(view.enforced, false);
    assert.match(view.error ?? "", /does not exist/);
  });
});

describe("project grouping", () => {
  test("groups by project, sorted, with unlisted projects named by id and empty projects kept", () => {
    const groups = groupByProject(lists, "");
    assert.deepEqual(groups.map((g) => g.name), ["Alpha", "Empty", "pX", "Zeta"]);
    assert.deepEqual(groups[0].workspaces.map((w) => w.name), ["alpha", "beta"]);
    assert.deepEqual(groups[1].workspaces, []);
  });
  test("filter matches a project (all its workspaces) or single workspaces", () => {
    assert.deepEqual(groupByProject(lists, "alpha").map((g) => [g.name, g.workspaces.length]), [["Alpha", 2]]);
    assert.deepEqual(groupByProject(lists, "MAIN").map((g) => [g.name, g.workspaces.length]), [["Zeta", 1]]);
    assert.deepEqual(groupByProject(lists, "nothing"), []);
  });
  test("entries for projects and workspaces the daemon does not list", () => {
    const scopes: Scopes = {
      ...empty,
      projects: { p1: { set: "a", enforce: false }, gone: { set: "a", enforce: true } },
      workspaces: { w1: { set: "a", enforce: false }, w404: { set: "a", enforce: false } },
    };
    assert.deepEqual(unlistedEntries(scopes, lists), { projects: ["gone"], workspaces: ["w404"] });
  });
});

describe("set and row edits", () => {
  const routing: Routing = {
    active: "economy",
    presets: [
      { name: "economy", summary: "", routes: [{ tier: "routine", provider: "p", model: "m", effort: "high", note: "" }] },
      { name: "quality", summary: "", routes: [{ tier: "routine", provider: "q", model: "m", effort: "high", note: "" }] },
    ],
  };
  test("name validation", () => {
    const names = ["economy", "quality"];
    assert.equal(nameProblem(names, "fresh_1"), null);
    assert.match(nameProblem(names, "economy") ?? "", /already exists/);
    assert.match(nameProblem(names, "bad name") ?? "", /letters/i);
    assert.ok(nameProblem(names, ""));
  });
  test("tier validation", () => {
    assert.equal(tierProblem(routing.presets[0].routes, "lead"), null);
    assert.match(tierProblem(routing.presets[0].routes, "routine") ?? "", /already exists/);
  });
  test("add and remove rows touch only the named set, and keep the last row", () => {
    const added = addRoute(routing, "economy", "lead");
    assert.deepEqual(added.presets[0].routes.map((r) => r.tier), ["routine", "lead"]);
    assert.equal(added.presets[1], routing.presets[1]);
    assert.deepEqual(removeRoute(added, "economy", "routine").presets[0].routes.map((r) => r.tier), ["lead"]);
    assert.equal(removeRoute(routing, "economy", "routine").presets[0].routes.length, 1);
    assert.equal(routing.presets[0].routes.length, 1);
  });
});

describe("route model entry", () => {
  const ready = {
    id: "example-peer",
    label: "Example Peer",
    enabled: true,
    models: [{ id: "model-small-5.5", label: "Small 5.5", efforts: [{ id: "low", label: "low" }] }],
  };
  test("a listed catalogue gives dropdowns; efforts follow the chosen model", () => {
    assert.deepEqual(
      [modelEntry(ready, "model-small-5.5").models, modelEntry(ready, "model-small-5.5").efforts],
      ["list", "list"],
    );
    assert.equal(modelEntry(ready, "").efforts, "text");
  });
  test("no catalogue (loading, unavailable, unknown provider) falls back to typed model and effort", () => {
    const loading = { ...ready, models: [], modelsStatus: "loading" as const };
    assert.deepEqual(modelEntry(loading, ""), { models: "text", efforts: "text", hint: "loading models..." });
    assert.match(modelEntry({ ...loading, modelsStatus: "unavailable" }, "").hint, /no model list/);
    assert.match(modelEntry(undefined, "x").hint, /not found/);
  });
  test("the screen polls only while an enabled provider is still loading", () => {
    assert.ok(providersLoading([{ ...ready, models: [], modelsStatus: "loading" }]));
    assert.ok(!providersLoading([{ ...ready, enabled: false, models: [], modelsStatus: "loading" }]));
    assert.ok(!providersLoading([ready]));
    assert.ok(!providersLoading(undefined));
  });
});
