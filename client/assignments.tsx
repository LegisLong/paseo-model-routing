import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import type { Scopes, ScopesState } from "../shared/scopes";
import { resolveScopeRpc } from "../shared/scopes";
import type { ScopeTable, WorkspaceRow } from "./scope-model";
import {
  assignSet,
  draftEffective,
  errorText,
  groupByProject,
  INHERIT,
  scopeChanged,
  setEnforce,
  unlistedEntries,
} from "./scope-model";
import type { HoverState, Option } from "./ui-kit";
import { Button, Dropdown, Field, FONT, Label, Message, Panel, tint, Toggle, ToggleSpace, useColors } from "./ui-kit";

const SET_WIDTH = 180;

/** One scope line: name, the set it uses, where that set comes from, and its enforce switch. */
function Row({
  name,
  detail,
  strong,
  indent,
  picker,
  via,
  viaTone,
  enforce,
  testID,
}: {
  name: string;
  detail?: string | null;
  strong?: boolean;
  indent?: boolean;
  picker: ReactNode;
  via: string;
  viaTone?: "danger" | "warning";
  enforce: ReactNode;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <View
      testID={testID}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 38, paddingVertical: 3, paddingLeft: indent ? 28 : 10, paddingRight: 10 }}
    >
      <View style={{ flex: 1, minWidth: 90 }}>
        <Label weight={strong ? "600" : "400"} lines={1}>
          {name}
        </Label>
        {detail ? (
          <Label muted size={FONT.small} lines={1}>
            {detail}
          </Label>
        ) : null}
      </View>
      <View style={{ width: SET_WIDTH, alignItems: "flex-end" }}>
        {picker}
        <Label
          size={FONT.small}
          lines={1}
          tone={viaTone}
          style={{ marginTop: -3, paddingRight: 8, color: viaTone ? undefined : tint(colors.foregroundMuted, 0.85) }}
        >
          {via}
        </Label>
      </View>
      <View style={{ width: 40, alignItems: "flex-end" }}>{enforce}</View>
    </View>
  );
}

function SetPicker({
  table,
  id,
  label,
  scopes,
  sets,
  inheritSet,
  inheritFrom,
  onChange,
}: {
  table: ScopeTable;
  id: string;
  label: string;
  scopes: Scopes;
  sets: string[];
  /** The set this scope uses without its own entry, and where that comes from. */
  inheritSet: string | null;
  inheritFrom: string;
  onChange(next: Scopes): void;
}) {
  const entry = scopes[table][id];
  const options: Option<string>[] = [
    {
      value: INHERIT,
      label: inheritSet ? `Inherit (${inheritFrom}: ${inheritSet})` : "Inherit (remove entry)",
      short: inheritSet ?? "inherit",
      muted: true,
    },
    ...sets.map((name) => ({ value: name, label: name })),
  ];
  const missing = Boolean(entry && !sets.includes(entry.set));
  if (entry && missing) options.push({ value: entry.set, label: `${entry.set} (missing)`, muted: true });
  return (
    <Dropdown
      accessibilityLabel={`Set for ${table === "projects" ? "project" : "workspace"} ${label}`}
      variant="quiet"
      tone={entry ? "accent" : "muted"}
      value={entry?.set ?? INHERIT}
      options={options}
      warn={missing}
      onChange={(value) => onChange(assignSet(scopes, table, id, value))}
    />
  );
}

function EnforceCell({ table, id, label, scopes, onChange }: { table: ScopeTable; id: string; label: string; scopes: Scopes; onChange(next: Scopes): void }) {
  const entry = scopes[table][id];
  if (!entry) return <ToggleSpace />;
  return (
    <Toggle
      testID={`enforce-${id}`}
      label={`Enforce ${label}`}
      value={entry.enforce}
      onChange={(value) => onChange(setEnforce(scopes, table, id, value))}
    />
  );
}

/** Revisions each role must carry for one workspace, as saved. */
function RevLine({ workspace, version }: { workspace: WorkspaceRow; version: string }) {
  const resolve = useRpc(resolveScopeRpc);
  const query = useQuery({
    queryKey: ["model-routing", "resolve", workspace.id, version],
    queryFn: () => resolve({ workspaceId: workspace.id, projectId: workspace.projectId }),
  });
  let text: string;
  if (query.isPending) text = "loading...";
  else if (query.isError) text = errorText(query.error);
  else if (!query.data.views) text = "effective set cannot be read";
  else {
    const { lead, peer } = query.data.views;
    text = [
      query.data.effective.set ?? "unknown",
      query.data.effective.enforced ? "enforced" : "not enforced",
      peer ? `Peer rev ${peer.revision}` : "no Peer tiers",
      lead ? `lead rev ${lead.revision}` : "no lead row",
    ].join(" · ");
  }
  return (
    <View testID={`roles-${workspace.id}`} style={{ flexDirection: "row", gap: 8 }}>
      <Label size={12} lines={1} style={{ width: 120 }}>
        {workspace.name}
      </Label>
      <Label muted size={12} style={{ flex: 1, fontFamily: "monospace" }}>
        {text}
      </Label>
    </View>
  );
}

function Details({ workspaces, version, files }: { workspaces: WorkspaceRow[]; version: string; files: string[] }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: 18, paddingVertical: 10, gap: 8 }}>
      <Pressable
        testID="details-toggle"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={({ hovered }: HoverState) => ({ flexDirection: "row", alignItems: "center", gap: 4, opacity: hovered ? 0.8 : 1 })}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={13} color={colors.foregroundMuted} />
        <Label muted size={12}>
          Details · revisions and guard
        </Label>
      </Pressable>
      {open ? (
        <View style={{ gap: 4 }}>
          <Label muted size={12}>
            As saved. A Lead or Supervisor creating an agent in an enforced scope must pass the matching rev in the
            routing-rev label; otherwise the guard refuses and shows the current table.
          </Label>
          {workspaces.map((workspace) => (
            <RevLine key={workspace.id} workspace={workspace} version={version} />
          ))}
          <Label muted size={FONT.small} style={{ marginTop: 4 }}>
            Files: {files.join(" · ")}
          </Label>
        </View>
      ) : null}
    </View>
  );
}

export type AssignmentsProps = {
  state: ScopesState;
  /** Scopes as loaded (to tell which rows have unsaved changes) and as edited. */
  saved: Scopes;
  scopes: Scopes;
  sets: string[];
  globalSet: string;
  globalChanged: boolean;
  /** Changes when either file changes, so revisions are read again. */
  version: string;
  onChange(next: Scopes): void;
  files: string[];
  style?: object;
};

export function Assignments({ state, saved, scopes, sets, globalSet, globalChanged, version, onChange, files, style }: AssignmentsProps) {
  const colors = useColors();
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupByProject(state, query), [state, query]);
  const unlisted = useMemo(() => unlistedEntries(scopes, state), [scopes, state]);
  const listed = useMemo(() => groups.flatMap((group) => group.workspaces), [groups]);

  return (
    <Panel
      testID="assignments-panel"
      title="Projects & workspaces"
      style={style}
      right={<Field value={query} placeholder="Filter" onChangeText={setQuery} style={{ width: 140 }} />}
    >
      <View style={{ flexDirection: "row", paddingHorizontal: 20, paddingBottom: 4 }}>
        <View style={{ flex: 1 }} />
        <Label muted size={FONT.small}>
          Enforce
        </Label>
      </View>
      {scopes.global.enforce ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 18, paddingBottom: 8 }}>
          <Message tone="warning" text="model-routing-scopes.json turns global enforcement on; this version refuses to save that." />
          <Button label="Turn off" onPress={() => onChange({ ...scopes, global: { enforce: false } })} />
        </View>
      ) : null}
      {state.listError ? (
        <View style={{ paddingHorizontal: 18, paddingBottom: 8 }}>
          <Message tone="warning" text={`Lists may be incomplete: ${state.listError}`} />
        </View>
      ) : null}

      <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
        {groups.length === 0 ? (
          <View style={{ padding: 10 }}>
            <Label muted>{query ? "Nothing matches the filter." : "The daemon lists no projects."}</Label>
          </View>
        ) : null}
        {groups.map((group, index) => {
          const projectEntry = scopes.projects[group.id];
          const projectPending = JSON.stringify(saved.projects[group.id]) !== JSON.stringify(projectEntry);
          const projectVia = projectEntry ? "project" : "inherits global";
          return (
            <View
              key={group.id}
              testID={`project-${group.id}`}
              style={{ borderTopWidth: index === 0 ? 0 : 1, borderTopColor: tint(colors.border, 0.6), paddingVertical: 4 }}
            >
              <Row
                strong
                name={group.name}
                picker={
                  <SetPicker
                    table="projects"
                    id={group.id}
                    label={group.name}
                    scopes={scopes}
                    sets={sets}
                    inheritSet={globalSet}
                    inheritFrom="global"
                    onChange={onChange}
                  />
                }
                via={projectPending || (!projectEntry && globalChanged) ? `${projectVia} · unsaved` : projectVia}
                viaTone={projectPending ? "warning" : undefined}
                enforce={<EnforceCell table="projects" id={group.id} label={group.name} scopes={scopes} onChange={onChange} />}
              />
              {group.workspaces.map((workspace) => {
                const effective = draftEffective(scopes, globalSet, sets, workspace);
                const own = scopes.workspaces[workspace.id];
                const pending =
                  scopeChanged(saved, scopes, workspace.id, workspace.projectId) ||
                  (globalChanged && effective.scope.kind === "global");
                const base = own ? "override" : projectEntry ? "inherits project" : "inherits global";
                const via = [
                  effective.error ? "missing set" : base,
                  !own && effective.enforced ? "enforced" : null,
                  pending ? "unsaved" : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <Row
                    key={workspace.id}
                    testID={`workspace-${workspace.id}`}
                    indent
                    name={workspace.name}
                    picker={
                      <SetPicker
                        table="workspaces"
                        id={workspace.id}
                        label={workspace.name}
                        scopes={scopes}
                        sets={sets}
                        inheritSet={projectEntry?.set ?? globalSet}
                        inheritFrom={projectEntry ? "project" : "global"}
                        onChange={onChange}
                      />
                    }
                    via={via}
                    viaTone={effective.error ? "danger" : pending ? "warning" : undefined}
                    enforce={
                      <EnforceCell table="workspaces" id={workspace.id} label={workspace.name} scopes={scopes} onChange={onChange} />
                    }
                  />
                );
              })}
            </View>
          );
        })}

        {unlisted.projects.map((id) => (
          <Row
            key={`project-${id}`}
            name="Project not listed by the daemon"
            detail={id}
            picker={<SetPicker table="projects" id={id} label={id} scopes={scopes} sets={sets} inheritSet={null} inheritFrom="" onChange={onChange} />}
            via="not listed"
            viaTone="warning"
            enforce={<EnforceCell table="projects" id={id} label={id} scopes={scopes} onChange={onChange} />}
          />
        ))}
        {unlisted.workspaces.map((id) => (
          <Row
            key={`workspace-${id}`}
            name="Workspace not listed by the daemon"
            detail={id}
            picker={<SetPicker table="workspaces" id={id} label={id} scopes={scopes} sets={sets} inheritSet={null} inheritFrom="" onChange={onChange} />}
            via="not listed"
            viaTone="warning"
            enforce={<EnforceCell table="workspaces" id={id} label={id} scopes={scopes} onChange={onChange} />}
          />
        ))}
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14, paddingHorizontal: 18, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border }}>
        <Label muted size={FONT.small}>
          <Label size={FONT.small} weight="600" style={{ color: colors.accent }}>
            Green
          </Label>
          : set here
        </Label>
        <Label muted size={FONT.small}>
          Grey: inherited
        </Label>
        <Label muted size={FONT.small}>
          Enforce: guard checks new agents
        </Label>
      </View>
      <Details workspaces={listed} version={version} files={files} />
    </Panel>
  );
}
