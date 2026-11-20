import { useState } from "react";
import { Pressable, View } from "react-native";
import type { ProviderOption, Route, Routing } from "../shared/routing";
import { LEAD_TIER, NO_PROVIDER } from "../shared/routing";
import { listPhrase } from "../shared/scopes";
import type { Scopes, ScopesState, SetOp } from "../shared/scopes";
import { addRoute, modelEntry, nameProblem, removeRoute, scopeRefName, setRefs, setUsage, tierProblem } from "./scope-model";
import type { HoverState, Option } from "./ui-kit";
import { Badge, Button, Dropdown, Field, FONT, Label, MenuButton, Message, Panel, tint, useColors } from "./ui-kit";
import { Icon } from "@getpaseo/plugin/client/ui";

const NONE = "__none__";
const COL = { tier: 104, provider: 132, model: 250, effort: 88, expand: 28 } as const;

function modelChoices(provider: ProviderOption | undefined, current: string): Option<string>[] {
  const models = provider?.models ?? [];
  const options: Option<string>[] = models.map((model) => ({ value: model.id, label: model.label, short: model.id }));
  if (current && !models.some((model) => model.id === current)) {
    options.unshift({ value: current, label: `${current} (not listed)`, short: current, muted: true });
  }
  if (!current) options.unshift({ value: NONE, label: "-", muted: true });
  return options;
}

function effortChoices(provider: ProviderOption | undefined, model: string, current: string): Option<string>[] {
  const efforts = provider?.models.find((entry) => entry.id === model)?.efforts ?? [];
  const options: Option<string>[] = efforts.map((effort) => ({ value: effort.id, label: effort.label, short: effort.id }));
  if (current && !efforts.some((effort) => effort.id === current)) {
    options.unshift({ value: current, label: `${current} (not listed)`, short: current, muted: true });
  }
  if (!current) options.unshift({ value: NONE, label: "-", muted: true });
  return options;
}

/** One route: tier, provider / model, effort inline; note and removal behind the row's expand. */
function RouteRow({
  route,
  providers,
  onChange,
  onRemove,
  narrow,
  first,
  expanded,
  onToggle,
}: {
  route: Route;
  providers: ProviderOption[];
  onChange(route: Route): void;
  /** Absent when this is the set's only row. */
  onRemove?: () => void;
  narrow: boolean;
  first: boolean;
  expanded: boolean;
  onToggle(): void;
}) {
  const colors = useColors();
  const provider = providers.find((entry) => entry.id === route.provider);
  const isLead = route.tier === LEAD_TIER;
  const missing = Boolean(route.provider) && !provider;
  const providerOptions: Option<string>[] = [
    { value: NONE, label: "- (no single model)", short: "no single model", muted: true },
    ...providers.map((entry) => ({
      value: entry.id,
      label: entry.enabled ? entry.label : `${entry.label} (disabled)`,
      short: entry.id,
      muted: !entry.enabled,
    })),
  ];
  if (missing) {
    providerOptions.splice(1, 0, { value: route.provider, label: `${route.provider} (not found)`, short: route.provider });
  }

  function pickProvider(value: string) {
    const id = value === NONE ? NO_PROVIDER : value;
    const next = providers.find((entry) => entry.id === id);
    const model = next?.models[0];
    const effort =
      model?.efforts.find((option) => option.id === route.effort)?.id ?? model?.efforts.at(-1)?.id ?? "";
    onChange({ ...route, provider: id, model: id ? model?.id ?? "" : "", effort: id ? effort : "" });
  }

  function pickModel(value: string) {
    const id = value === NONE ? "" : value;
    const efforts = provider?.models.find((entry) => entry.id === id)?.efforts ?? [];
    const effort = efforts.some((option) => option.id === route.effort) ? route.effort : efforts.at(-1)?.id ?? "";
    onChange({ ...route, model: id, effort });
  }

  const entry = modelEntry(provider, route.model);
  const tierCell = (
    <View style={{ width: narrow ? undefined : COL.tier, flex: narrow ? 1 : undefined, flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Label weight="500" lines={1}>
        {route.tier}
      </Label>
      {isLead ? <Badge text="Supervisor" tone="accent" /> : null}
    </View>
  );
  const providerCell = (
    <View style={{ width: COL.provider, flexShrink: 0 }}>
      <Dropdown
        accessibilityLabel={`Provider for ${route.tier}`}
        variant="quiet"
        tone="muted"
        value={route.provider || NONE}
        options={providerOptions}
        onChange={pickProvider}
        warn={missing}
      />
    </View>
  );
  const modelCells = route.provider ? (
    <>
      <Label muted style={{ color: tint(colors.foregroundMuted, 0.6) }}>
        /
      </Label>
      <View style={narrow ? { flex: 1, minWidth: 140 } : { flex: 1, minWidth: 100, maxWidth: COL.model + 60 }}>
        {entry.models === "list" ? (
          <Dropdown
            accessibilityLabel={`Model for ${route.tier}`}
            variant="quiet"
            value={route.model || NONE}
            options={modelChoices(provider, route.model)}
            onChange={pickModel}
          />
        ) : (
          <Field
            accessibilityLabel={`Model for ${route.tier}`}
            value={route.model}
            placeholder={entry.hint}
            onChangeText={(model) => onChange({ ...route, model: model.trim() })}
          />
        )}
      </View>
      <View style={{ width: COL.effort, flexShrink: 0 }}>
        {entry.efforts === "list" ? (
          <Dropdown
            accessibilityLabel={`Effort for ${route.tier}`}
            variant="quiet"
            value={route.effort || NONE}
            options={effortChoices(provider, route.model, route.effort)}
            onChange={(value) => onChange({ ...route, effort: value === NONE ? "" : value })}
          />
        ) : (
          <Field
            accessibilityLabel={`Effort for ${route.tier}`}
            value={route.effort}
            placeholder="effort"
            onChangeText={(effort) => onChange({ ...route, effort: effort.trim() })}
          />
        )}
      </View>
    </>
  ) : (
    <Label muted style={{ flex: 1, fontStyle: "italic" }} lines={1}>
      {route.note || "No single model"}
    </Label>
  );
  const expandCell = (
    <Pressable
      testID={`route-expand-${route.tier}`}
      accessibilityRole="button"
      accessibilityLabel={`${expanded ? "Hide" : "Show"} note and options for ${route.tier}`}
      accessibilityState={{ expanded }}
      onPress={onToggle}
      style={({ hovered }: HoverState) => ({
        width: COL.expand,
        height: 28,
        borderRadius: 7,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: expanded || hovered ? colors.surface2 : "transparent",
      })}
    >
      <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={15} color={colors.foregroundMuted} />
    </Pressable>
  );

  return (
    <View
      testID={`route-${route.tier}`}
      style={{ borderTopWidth: first ? 0 : 1, borderTopColor: tint(colors.border, 0.6), paddingVertical: 6, paddingHorizontal: 8 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: narrow ? "wrap" : "nowrap", gap: 8, minHeight: 32 }}>
        {tierCell}
        {narrow ? expandCell : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1, flexBasis: narrow ? "100%" : undefined }}>
          {providerCell}
          {modelCells}
        </View>
        {narrow ? null : expandCell}
      </View>
      {expanded ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            flexWrap: "wrap",
            gap: 10,
            marginTop: 6,
            marginLeft: narrow ? 0 : COL.tier + 8,
            padding: 10,
            borderRadius: 8,
            backgroundColor: colors.surface1,
          }}
        >
          <Field
            accessibilityLabel={`Note for ${route.tier}`}
            multiline
            value={route.note}
            placeholder={isLead ? "Note shown to Supervisor" : "Note shown to Lead"}
            onChangeText={(note) => onChange({ ...route, note })}
            style={{ flex: 1, minWidth: 220 }}
          />
          {onRemove ? <Button label="Remove row" tone="danger" onPress={onRemove} /> : null}
        </View>
      ) : null}
    </View>
  );
}

type Mode = "create" | "duplicate" | "rename" | "delete" | null;

export type SetsPanelProps = {
  routing: Routing;
  providers: ProviderOption[];
  scopes: Scopes | null;
  /** Project and workspace names, to say where a set is used. */
  names: Pick<ScopesState, "projects" | "workspaces">;
  selected: string;
  onSelect(name: string): void;
  onChange(change: (current: Routing) => Routing): void;
  /** Why set operations are unavailable (unsaved edits), or null. */
  lockReason: string | null;
  busy: boolean;
  /** Runs a set operation; resolves to the refusal text, or null on success. */
  runOp(op: SetOp, select: string | null): Promise<string | null>;
  narrow: boolean;
};

function SetCard({ label, meta, active, global, onPress, testID, dashed, disabled }: {
  label: string;
  meta?: string;
  active?: boolean;
  global?: boolean;
  onPress(): void;
  testID?: string;
  dashed?: boolean;
  disabled?: boolean;
}) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole={dashed ? "button" : "tab"}
      accessibilityState={{ selected: Boolean(active), disabled: Boolean(disabled) }}
      accessibilityLabel={dashed ? label : `Set ${label}`}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered }: HoverState) => ({
        width: 124,
        minHeight: 56,
        paddingHorizontal: 12,
        paddingVertical: 9,
        borderRadius: 10,
        borderWidth: 1,
        borderStyle: dashed ? "dashed" : "solid",
        borderColor: active ? colors.accent : hovered && !disabled ? colors.foregroundMuted : colors.border,
        backgroundColor: active ? tint(colors.accent, 0.06) : "transparent",
        justifyContent: dashed ? "center" : "flex-start",
        alignItems: dashed ? "center" : "stretch",
        opacity: disabled ? 0.5 : 1,
      })}
    >
      {dashed ? (
        <Label muted>{label}</Label>
      ) : (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {global ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent }} /> : null}
            <Label weight="600" lines={1} style={{ flexShrink: 1 }}>
              {label}
            </Label>
          </View>
          {meta ? (
            <Label muted size={FONT.small} lines={1} style={{ marginTop: 2 }}>
              {meta}
            </Label>
          ) : null}
        </>
      )}
    </Pressable>
  );
}

export function SetsPanel({
  routing,
  providers,
  scopes,
  names: scopeNames,
  selected,
  onSelect,
  onChange,
  lockReason,
  busy,
  runOp,
  narrow,
}: SetsPanelProps) {
  const colors = useColors();
  const [mode, setMode] = useState<Mode>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<{ mode: Mode; text: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newTier, setNewTier] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const names = routing.presets.map((entry) => entry.name);
  const preset = routing.presets.find((entry) => entry.name === selected) ?? routing.presets[0];
  if (!preset) return null;
  const locked = busy || lockReason !== null;
  const hasLead = preset.routes.some((route) => route.tier === LEAD_TIER);
  const nameError = name ? nameProblem(names, name) : null;
  const tierError = newTier ? tierProblem(preset.routes, newTier) : null;
  const refs = setRefs(scopes, preset.name).map((ref) => scopeRefName(ref, scopeNames));
  // Lead row first, then the Peer tiers in file order.
  const rows = preset.routes
    .map((route, index) => ({ route, index }))
    .sort((a, b) => Number(b.route.tier === LEAD_TIER) - Number(a.route.tier === LEAD_TIER));

  function begin(next: Mode) {
    setNotice(null);
    if (next && lockReason) {
      setNotice(lockReason);
      return;
    }
    setMode(mode === next ? null : next);
    setName(next === "rename" ? preset.name : "");
    setError(null);
  }

  async function submit() {
    if (!mode) return;
    const op: SetOp =
      mode === "create"
        ? {
            kind: "create",
            name,
            summary: "",
            routes: [{ tier: "routine", provider: "", model: "", effort: "", note: "" }],
          }
        : mode === "duplicate"
          ? { kind: "duplicate", from: preset.name, name }
          : mode === "rename"
            ? { kind: "rename", from: preset.name, to: name }
            : { kind: "delete", name: preset.name };
    const current = mode;
    const refusal = await runOp(op, mode === "delete" ? null : name);
    if (refusal) {
      setError({ mode: current, text: refusal });
      if (current === "delete") setMode(null);
      return;
    }
    setMode(null);
    setName("");
    setError(null);
  }

  function updateRoutes(change: (routes: Route[]) => Route[], summary?: string) {
    onChange((current) => ({
      ...current,
      presets: current.presets.map((entry) =>
        entry.name === preset.name
          ? { ...entry, routes: change(entry.routes), summary: summary ?? entry.summary }
          : entry,
      ),
    }));
  }

  function pickAction(action: string) {
    if (action === "lead") {
      onChange((current) => addRoute(current, preset.name, LEAD_TIER));
      setExpanded(LEAD_TIER);
      return;
    }
    begin(action as Mode);
  }

  const opLabel = { create: "Create", duplicate: "Duplicate", rename: "Rename", delete: "Delete" } as const;
  const nameMode = mode === "create" || mode === "duplicate" || mode === "rename";
  const actions: Option<string>[] = [
    { value: "duplicate", label: "Duplicate…" },
    { value: "rename", label: "Rename…" },
    ...(hasLead ? [] : [{ value: "lead", label: "Add lead row" }]),
    { value: "delete", label: "Delete set", danger: true },
  ];

  return (
    <Panel
      testID="sets-panel"
      title="Sets"
      hint="Reusable routing tables. Lead creates Peers from the tiers; Supervisor uses the lead row."
    >
      {/* Overview of every set */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 18, paddingBottom: 14 }}>
        {routing.presets.map((entry) => {
          const used = setUsage(scopes, entry.name);
          const meta =
            entry.name === routing.active ? "global default" : used > 0 ? `used ×${used}` : `${entry.routes.length} rows`;
          return (
            <SetCard
              key={entry.name}
              testID={`set-tab-${entry.name}`}
              label={entry.name}
              meta={meta}
              global={entry.name === routing.active}
              active={entry.name === preset.name}
              onPress={() => {
                onSelect(entry.name);
                setMode(null);
                setError(null);
                setNotice(null);
                setExpanded(null);
              }}
            />
          );
        })}
        <SetCard testID="new-set" label="+ New set" dashed onPress={() => begin("create")} disabled={busy} />
      </View>

      {/* Selected set */}
      <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: 18, paddingTop: 14, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <Label size={16} weight="600">
            {preset.name}
          </Label>
          {preset.name === routing.active ? <Badge text="global default" tone="accent" /> : null}
          <Label muted size={12} style={{ flexShrink: 1 }}>
            {refs.length ? `used by ${listPhrase(refs)}` : "not assigned"}
          </Label>
          <View style={{ flex: 1 }} />
          <MenuButton testID="set-menu" label={`Actions for set ${preset.name}`} actions={actions} onPick={pickAction} disabled={busy} />
        </View>

        {notice ? <Message tone="neutral" text={notice} /> : null}
        {nameMode ? (
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, paddingVertical: 4 }}>
            <Label muted size={12}>
              {mode === "create" ? "New set name" : mode === "duplicate" ? `Copy ${preset.name} as` : `Rename ${preset.name} to`}
            </Label>
            <Field
              testID="set-name"
              autoFocus
              value={name}
              placeholder="letters, digits, - and _"
              onChangeText={(text) => {
                setName(text.trim());
                setError(null);
              }}
              onSubmit={() => (nameProblem(names, name) ? undefined : void submit())}
              error={Boolean(nameError)}
              style={{ width: 220 }}
            />
            <Button
              label={busy ? "Working..." : opLabel[mode]}
              tone="primary"
              disabled={busy || nameProblem(names, name) !== null}
              onPress={() => void submit()}
            />
            <Button label="Cancel" tone="ghost" onPress={() => begin(null)} />
            {mode === "rename" ? (
              <Label muted size={FONT.small}>
                Assignments and the global default follow the new name.
              </Label>
            ) : null}
          </View>
        ) : null}
        {nameMode && nameError ? <Message text={nameError} /> : null}
        {mode === "delete" ? (
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, paddingVertical: 4 }}>
            <Message tone="warning" text={`Delete set ${preset.name} from model-routing.md?`} />
            <Button label={`Confirm delete ${preset.name}`} tone="danger" disabled={busy} onPress={() => void submit()} />
            <Button label="Cancel" tone="ghost" onPress={() => begin(null)} />
          </View>
        ) : null}
        {error ? <Message text={`${opLabel[error.mode ?? "delete"]} refused: ${error.text}`} /> : null}
        <Field
          testID="set-summary"
          accessibilityLabel="Summary"
          quiet
          multiline
          value={preset.summary}
          placeholder="Add a summary"
          onChangeText={(summary) => updateRoutes((routes) => routes, summary)}
          style={{ marginLeft: -8 }}
        />
      </View>

      {/* Route rows */}
      <View style={{ paddingHorizontal: 10, paddingTop: 4 }}>
        {rows.map(({ route, index }, position) => (
          <RouteRow
            key={`${preset.name}-${route.tier}`}
            first={position === 0}
            narrow={narrow}
            route={route}
            providers={providers}
            expanded={expanded === route.tier}
            onToggle={() => setExpanded(expanded === route.tier ? null : route.tier)}
            onChange={(next) => updateRoutes((routes) => routes.map((entry, at) => (at === index ? next : entry)))}
            onRemove={
              preset.routes.length > 1 ? () => onChange((current) => removeRoute(current, preset.name, route.tier)) : undefined
            }
          />
        ))}
      </View>

      {/* Add a tier */}
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, paddingHorizontal: 18, paddingTop: 6, paddingBottom: 14 }}>
        {newTier === null ? (
          <Button testID="add-tier" label="Add tier" icon="Plus" tone="ghost" onPress={() => setNewTier("")} />
        ) : (
          <>
            <Field
              testID="new-tier"
              autoFocus
              value={newTier}
              placeholder="tier name"
              onChangeText={(text) => setNewTier(text.trim())}
              error={Boolean(tierError)}
              style={{ width: COL.tier + 20 }}
            />
            <Button
              label="Add"
              tone="primary"
              disabled={!newTier || tierError !== null}
              onPress={() => {
                onChange((current) => addRoute(current, preset.name, newTier));
                setExpanded(newTier);
                setNewTier(null);
              }}
            />
            <Button label="Cancel" tone="ghost" onPress={() => setNewTier(null)} />
            {tierError ? <Message text={tierError} /> : null}
          </>
        )}
        {!hasLead ? (
          <Label muted size={FONT.small}>
            No lead row: Supervisor creations are not checked against this set.
          </Label>
        ) : null}
      </View>
    </Panel>
  );
}
