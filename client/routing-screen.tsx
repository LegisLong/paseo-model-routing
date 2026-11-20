import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { Routing, RoutingState } from "../shared/routing";
import { readRoutingRpc, saveRoutingRpc } from "../shared/routing";
import type { Scopes, ScopesState, SetOp } from "../shared/scopes";
import { manageSetRpc, readScopesRpc, saveScopesRpc } from "../shared/scopes";
import { Assignments } from "./assignments";
import type { Snapshot } from "./scope-model";
import {
  draftStatus,
  errorText,
  isStaleError,
  nameScopeRefs,
  providersLoading,
  setInUseText,
  staleSaveMessage,
} from "./scope-model";
import { SetsPanel } from "./sets-panel";
import { Button, Dropdown, KitProvider, Label, Message, tint, useCloseMenu, useColors } from "./ui-kit";

const ROUTING_KEY = ["model-routing", "state"];
const SCOPES_KEY = ["model-routing", "scopes"];
/** Below this content width the tables wrap their cells onto two lines. */
const NARROW_WIDTH = 900;
const PROVIDER_POLL_MS = 3000;

/**
 * Local copy of a file's content. It follows the server copy while it has no edits; with edits
 * it stays put when the file changes on disk (`stale`) until the owner reloads on purpose.
 */
function useDraft<T>(server: Snapshot<T> | undefined, empty: T) {
  const [base, setBase] = useState<Snapshot<T> | null>(null);
  const [draft, setDraft] = useState<T>(empty);
  const status = draftStatus(base, draft, server);
  useEffect(() => {
    if (server && status.follow) {
      setBase(server);
      setDraft(server.value);
    }
  }, [server?.revision, status.follow]);
  function adopt(next: Snapshot<T>) {
    setBase(next);
    setDraft(next.value);
  }
  return { base, draft, setDraft, adopt, ...status };
}

const routingSnapshot = (state: RoutingState | undefined): Snapshot<Routing | null> | undefined =>
  state && { revision: state.revision, value: state.routing };
const scopesSnapshot = (state: ScopesState | undefined): Snapshot<Scopes | null> | undefined =>
  state && { revision: state.revision, value: state.scopes };

export function RoutingScreen({ theme }: PluginScreenProps) {
  const [width, setWidth] = useState(0);
  return (
    <KitProvider colors={theme.colors} style={{ flex: 1, backgroundColor: theme.colors.surface0 }} onLayout={setWidth}>
      <ScreenBody narrow={width > 0 && width < NARROW_WIDTH} />
    </KitProvider>
  );
}

function ScreenBody({ narrow }: { narrow: boolean }) {
  const colors = useColors();
  const closeMenu = useCloseMenu();
  const readRouting = useRpc(readRoutingRpc);
  const saveRouting = useRpc(saveRoutingRpc);
  const manageSet = useRpc(manageSetRpc);
  const readScopes = useRpc(readScopesRpc);
  const saveScopes = useRpc(saveScopesRpc);
  const queryClient = useQueryClient();
  const routingQuery = useQuery({
    queryKey: ROUTING_KEY,
    queryFn: () => readRouting({}),
    // The daemon discovers provider models lazily; read again until every catalogue has arrived.
    refetchInterval: (query) => (providersLoading(query.state.data?.providers) ? PROVIDER_POLL_MS : false),
  });
  const scopesQuery = useQuery({ queryKey: SCOPES_KEY, queryFn: () => readScopes({}) });
  const routingState = routingQuery.data;
  const scopesState = scopesQuery.data;

  const routingDraft = useDraft(routingSnapshot(routingState), null);
  const scopesDraft = useDraft(scopesSnapshot(scopesState), null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  if (routingQuery.isError || scopesQuery.isError) {
    return (
      <View style={{ padding: 24 }}>
        <Message text={errorText(routingQuery.error ?? scopesQuery.error)} />
      </View>
    );
  }
  if (!routingState || !scopesState || !routingDraft.base || !scopesDraft.base) return <Loading />;

  /** Project and workspace names, to show scopes by name in messages. */
  const scopeNames = scopesState;
  const draft = routingDraft.draft;
  const scopes = scopesDraft.draft;
  const names = draft?.presets.map((entry) => entry.name) ?? [];
  const editName = draft && editing && names.includes(editing) ? editing : draft?.active ?? "";
  const globalChanged = draft?.active !== routingDraft.base.value?.active;
  const anyDirty = routingDraft.dirty || scopesDraft.dirty;
  const saveable = (routingDraft.dirty && !routingDraft.stale) || (scopesDraft.dirty && !scopesDraft.stale);

  /** A refusal as the owner should read it: stale writes explain what was kept, scope ids become names. */
  function explain(error: unknown, keptEdits: boolean): string {
    const text = errorText(error);
    return isStaleError(text) ? staleSaveMessage(text, keptEdits) : nameScopeRefs(text, scopeNames);
  }

  /** The file moved on: read the new copy. Unsaved edits stay in the draft and raise the reload prompt. */
  function afterError(text: string) {
    if (isStaleError(text)) {
      void routingQuery.refetch();
      void scopesQuery.refetch();
    }
  }

  function applyRouting(next: RoutingState) {
    queryClient.setQueryData(ROUTING_KEY, next);
    routingDraft.adopt({ revision: next.revision, value: next.routing });
  }

  function applyScopes(next: ScopesState) {
    queryClient.setQueryData(SCOPES_KEY, next);
    scopesDraft.adopt({ revision: next.revision, value: next.scopes });
  }

  /** Saves each changed file that is not stale: sets and global default first, then assignments. */
  async function saveAll() {
    setBusy(true);
    setSaveError(null);
    setSaved(null);
    const done: string[] = [];
    try {
      if (routingDraft.dirty && !routingDraft.stale && routingDraft.base && draft) {
        applyRouting(await saveRouting({ revision: routingDraft.base.revision, routing: draft }));
        done.push("sets");
        // The global default feeds every workspace's effective set.
        await queryClient.invalidateQueries({ queryKey: SCOPES_KEY });
      }
      if (scopesDraft.dirty && !scopesDraft.stale && scopesDraft.base && scopes) {
        applyScopes(await saveScopes({ revision: scopesDraft.base.revision, scopes }));
        done.push("assignments");
      }
      setSaved(`Saved ${done.join(" and ")}.`);
    } catch (error) {
      const text = explain(error, true);
      setSaveError(done.length ? `Saved ${done.join(" and ")}; then: ${text}` : text);
      afterError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function runSetOp(op: SetOp, select: string | null): Promise<string | null> {
    if (!routingDraft.base) return "Not loaded.";
    // Refuse a delete the page already knows the server would refuse, naming the scopes.
    if (op.kind === "delete") {
      const inUse = setInUseText(scopesDraft.base?.value ?? null, op.name, scopeNames);
      if (inUse) return inUse;
    }
    setBusy(true);
    setSaved(null);
    try {
      applyRouting(await manageSet({ revision: routingDraft.base.revision, op }));
      setEditing(select);
      // Rename rewrites scope entries and so changes the scopes file.
      await queryClient.invalidateQueries({ queryKey: SCOPES_KEY });
      return null;
    } catch (error) {
      afterError(errorText(error));
      // Set operations run only without unsaved edits, so a stale refusal has nothing to keep.
      return explain(error, false);
    } finally {
      setBusy(false);
    }
  }

  async function reload(which: "routing" | "scopes" | "both") {
    setBusy(true);
    setSaveError(null);
    setSaved(null);
    try {
      if (which !== "scopes") {
        const snapshot = routingSnapshot((await routingQuery.refetch()).data);
        if (snapshot) routingDraft.adopt(snapshot);
      }
      if (which !== "routing") {
        const snapshot = scopesSnapshot((await scopesQuery.refetch()).data);
        if (snapshot) scopesDraft.adopt(snapshot);
      }
    } catch (error) {
      setSaveError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  const dirtyParts = [routingDraft.dirty ? "sets" : null, scopesDraft.dirty ? "assignments" : null].filter(Boolean);
  const problems = [
    routingState.parseError ? `Cannot edit sets: ${routingState.parseError}` : null,
    routingState.providersError ? `Provider list unavailable: ${routingState.providersError}` : null,
    scopesState.parseError
      ? `Cannot edit assignments: ${scopesState.parseError}. Fix model-routing-scopes.json, then reload.`
      : null,
  ].filter((text): text is string => text !== null);
  const staleFiles = (
    [
      ["routing", routingDraft.stale, "model-routing.md"],
      ["scopes", scopesDraft.stale, "model-routing-scopes.json"],
    ] as const
  ).filter(([, stale]) => stale);
  // A stale-save refusal is told inside the stale banner, not again under the header.
  const refusalInBanner = saveError !== null && staleFiles.some(([, , file]) => saveError.includes(`${file} changed on disk`));

  return (
    <>
      {/* Header: title, global default, file state and the save actions, always visible. */}
      <View style={{ paddingHorizontal: narrow ? 16 : 28, paddingTop: 18, paddingBottom: 12, gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 14 }}>
          <Label size={19} weight="600">
            Model routing
          </Label>
          {draft ? (
            <View
              testID="global-default"
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingLeft: 12,
                paddingRight: 3,
                paddingVertical: 3,
                borderRadius: 18,
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              <Label muted size={12}>
                Global default · new projects use
              </Label>
              <Dropdown
                accessibilityLabel="Global default set"
                variant="pill"
                value={draft.active}
                options={names.map((name) => ({ value: name, label: name }))}
                onChange={(active) => routingDraft.setDraft((current) => current && { ...current, active })}
              />
            </View>
          ) : null}
          <View style={{ flex: 1 }} />
          {dirtyParts.length ? (
            <Label testID="unsaved-note" size={12} tone="warning">{`Unsaved: ${dirtyParts.join(", ")}`}</Label>
          ) : saved ? (
            <Label size={12} tone="success">
              {saved}
            </Label>
          ) : null}
          {anyDirty ? (
            <Button
              label={confirmDiscard ? "Confirm discard" : "Discard"}
              tone={confirmDiscard ? "danger" : "ghost"}
              disabled={busy}
              onPress={() => {
                if (!confirmDiscard) {
                  setConfirmDiscard(true);
                  return;
                }
                setConfirmDiscard(false);
                void reload("both");
              }}
            />
          ) : (
            <Button label="Reload" icon="RefreshCw" tone="ghost" disabled={busy} onPress={() => void reload("both")} />
          )}
          <Button
            testID="save"
            label={busy ? "Working..." : "Save"}
            tone="primary"
            disabled={busy || !saveable}
            onPress={() => {
              setConfirmDiscard(false);
              void saveAll();
            }}
          />
        </View>
        {saveError && !refusalInBanner ? <Message text={`Not saved: ${saveError}`} /> : null}
      </View>

      <ScrollView
        style={{ flex: 1 }}
        onScroll={closeMenu}
        scrollEventThrottle={64}
        contentContainerStyle={{ paddingHorizontal: narrow ? 16 : 28, paddingBottom: 40, gap: 14 }}
      >
        {problems.map((text) => (
          <Message key={text} text={text} />
        ))}
        {staleFiles.map(([which, , file]) => (
          <View
            key={which}
            testID={`stale-${which}`}
            style={{
              flexDirection: "row",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 12,
              paddingVertical: 10,
              paddingHorizontal: 14,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: tint(colors.statusWarning, 0.35),
              backgroundColor: tint(colors.statusWarning, 0.08),
            }}
          >
            <Label style={{ flex: 1, minWidth: 240 }}>
              {refusalInBanner && saveError?.includes(file)
                ? `Not saved: ${saveError}`
                : `${file} changed on disk after you opened it. Your edits are kept here but cannot be saved over the new file.`}
            </Label>
            <Button label="Reload and discard my edits" disabled={busy} onPress={() => void reload(which)} />
          </View>
        ))}

        <View style={{ flexDirection: narrow ? "column" : "row", alignItems: "flex-start", gap: 20 }}>
          {draft ? (
            <View style={{ flex: narrow ? undefined : 1, alignSelf: "stretch", minWidth: 0 }}>
              <SetsPanel
                routing={draft}
                providers={routingState.providers}
                scopes={scopes}
                names={scopeNames}
                selected={editName}
                onSelect={setEditing}
                onChange={(change) => routingDraft.setDraft((current) => current && change(current))}
                lockReason={anyDirty ? "Save or discard your changes before creating, renaming or deleting sets." : null}
                busy={busy}
                runOp={runSetOp}
                narrow={narrow}
              />
            </View>
          ) : null}

          {draft && scopes ? (
            <Assignments
              style={narrow ? { alignSelf: "stretch" } : { width: 440 }}
              state={scopesState}
              saved={scopesDraft.base.value ?? scopes}
              scopes={scopes}
              sets={names}
              globalSet={draft.active}
              globalChanged={globalChanged}
              version={`${routingState.revision}:${scopesState.revision}`}
              onChange={scopesDraft.setDraft}
              files={[routingState.path, scopesState.path]}
            />
          ) : null}
        </View>
      </ScrollView>
    </>
  );
}
