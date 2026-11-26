import { useState } from "react";
import { View } from "react-native";
import type { RoleRule, Scopes } from "../shared/scopes";
import { DEFAULT_ROLE_RULES, describeMatch } from "../shared/scopes";
import {
  addRule,
  changeRule,
  customizeRoles,
  formatLabelText,
  moveRule,
  parseLabelText,
  removeRule,
  ruleProblem,
  useDefaultRoles,
} from "./scope-model";
import type { Option } from "./ui-kit";
import { Button, Dropdown, Field, FONT, IconButton, Label, Message, Panel, useColors } from "./ui-kit";

const ROLE_OPTIONS: Option<RoleRule["role"]>[] = [
  { value: "supervisor", label: "Supervisor (creates Leads)" },
  { value: "lead", label: "Lead (creates Peers)" },
];

/** One rule: provider pattern, labels, role, and its order controls. */
function RuleRow({
  rule,
  index,
  count,
  scopes,
  onChange,
  bump,
}: {
  rule: RoleRule;
  index: number;
  count: number;
  scopes: Scopes;
  onChange(next: Scopes): void;
  /** Called after a move or removal, so rows that keep text state start from the new order. */
  bump(): void;
}) {
  const colors = useColors();
  const [labelText, setLabelText] = useState(formatLabelText(rule.match.labels));
  const [labelError, setLabelError] = useState<string | null>(null);
  const problem = labelError ?? ruleProblem(rule);
  return (
    <View testID={`role-rule-${index}`} style={{ gap: 6, paddingVertical: 8, borderTopWidth: index === 0 ? 0 : 1, borderTopColor: colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Label muted size={FONT.small} style={{ width: 16 }}>
          {index + 1}
        </Label>
        <Field
          testID={`role-provider-${index}`}
          accessibilityLabel={`Rule ${index + 1} provider`}
          placeholder="Provider (exact, or with * wildcards)"
          value={rule.match.provider ?? ""}
          error={Boolean(problem) && !rule.match.provider}
          onChangeText={(text) => onChange(changeRule(scopes, index, { provider: text.trim() }))}
          style={{ flex: 1, minWidth: 120 }}
        />
        <IconButton name="ArrowUp" label={`Move rule ${index + 1} up`} disabled={index === 0} onPress={() => (onChange(moveRule(scopes, index, -1)), bump())} />
        <IconButton name="ArrowDown" label={`Move rule ${index + 1} down`} disabled={index === count - 1} onPress={() => (onChange(moveRule(scopes, index, 1)), bump())} />
        <IconButton name="Trash2" label={`Remove rule ${index + 1}`} onPress={() => (onChange(removeRule(scopes, index)), bump())} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 24 }}>
        <Field
          testID={`role-labels-${index}`}
          accessibilityLabel={`Rule ${index + 1} labels`}
          placeholder="Labels: key=value, key=value"
          value={labelText}
          error={labelError !== null}
          onChangeText={(text) => {
            setLabelText(text);
            const parsed = parseLabelText(text);
            setLabelError(parsed.error);
            if (!parsed.error) onChange(changeRule(scopes, index, { labels: parsed.labels }));
          }}
          style={{ flex: 1, minWidth: 120 }}
        />
        <Dropdown
          testID={`role-role-${index}`}
          accessibilityLabel={`Rule ${index + 1} role`}
          value={rule.role}
          options={ROLE_OPTIONS}
          width={190}
          onChange={(role) => onChange(changeRule(scopes, index, { role }))}
        />
      </View>
      {problem ? <Message text={problem} tone="danger" /> : null}
    </View>
  );
}

/** Which agents the guard treats as a Supervisor or a Lead: the default suffix rules, or your own list. */
export function RolesPanel({ scopes, onChange, style }: { scopes: Scopes; onChange(next: Scopes): void; style?: object }) {
  const [generation, setGeneration] = useState(0);
  const custom = scopes.roles !== undefined;
  const change = (next: Scopes) => {
    onChange(next);
    setGeneration((value) => value + 1);
  };
  return (
    <Panel
      testID="roles-panel"
      title="Agent roles"
      hint={custom ? "Your rules. The first match decides." : "Default rules"}
      style={style}
      right={
        custom ? (
          <Button label="Use default rules" tone="ghost" onPress={() => change(useDefaultRoles(scopes))} />
        ) : (
          <Button label="Customize" onPress={() => change(customizeRoles(scopes))} />
        )
      }
    >
      <View style={{ paddingHorizontal: 18, paddingBottom: 12, gap: 4 }}>
        <Label muted size={12}>
          The guard asks a creating agent for the routing-rev label only if a rule gives it a role. A Supervisor
          creates Leads and a Lead creates Peers.
        </Label>
        {!custom
          ? DEFAULT_ROLE_RULES.map((rule) => (
              <Label key={rule.role} size={12} style={{ fontFamily: "monospace" }}>
                {`${describeMatch(rule.match)}  ->  ${rule.role === "supervisor" ? "Supervisor" : "Lead"}`}
              </Label>
            ))
          : null}
        {custom && scopes.roles?.length === 0 ? (
          <Label size={12} tone="warning">
            No rules: no agent has a role, so the guard allows every creation.
          </Label>
        ) : null}
        {custom
          ? (scopes.roles ?? []).map((rule, index) => (
              <RuleRow
                key={`${generation}-${index}`}
                rule={rule}
                index={index}
                count={scopes.roles?.length ?? 0}
                scopes={scopes}
                onChange={onChange}
                bump={() => setGeneration((value) => value + 1)}
              />
            ))
          : null}
        {custom ? (
          <View style={{ flexDirection: "row", paddingTop: 6 }}>
            <Button testID="add-role-rule" label="Add rule" onPress={() => onChange(addRule(scopes))} />
          </View>
        ) : null}
      </View>
    </Panel>
  );
}
