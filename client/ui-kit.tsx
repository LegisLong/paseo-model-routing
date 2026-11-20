import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { createContext, useContext, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PressableStateCallbackType, StyleProp, TextStyle, ViewStyle } from "react-native";

/** React Native Web also reports hover to Pressable style callbacks. */
export type HoverState = PressableStateCallbackType & { hovered?: boolean };

// Small, dense controls drawn with the host's theme colors. The host's Settings* components
// are full-height settings rows; this screen needs table cells.

type Colors = PluginTheme["colors"];
const ColorsContext = createContext<Colors | null>(null);

export type Option<V extends string> = {
  value: V;
  label: string;
  muted?: boolean;
  /** Trigger text, when shorter than `label`. */
  short?: string;
  /** Destructive action in a menu. */
  danger?: boolean;
};

type OpenMenu = {
  id: string;
  /** Trigger box relative to the provider's root view. */
  x: number;
  y: number;
  width: number;
  height: number;
  value: string;
  options: readonly Option<string>[];
  onPick(value: string): void;
  /** Align the menu's right edge with the trigger's (for "•••" menus at a row's end). */
  align?: "left" | "right";
};

type MenuApi = {
  openId: string | null;
  open(id: string, trigger: View | null, menu: Omit<OpenMenu, "id" | "x" | "y" | "width" | "height">): void;
  close(): void;
};
const MenuContext = createContext<MenuApi>({ openId: null, open: () => {}, close: () => {} });

const MENU_MAX_HEIGHT = 280;

/**
 * Theme colors plus the one open dropdown menu. React Native Web gives every View z-index 0, so a
 * menu drawn inside a table row would sit under the next row; the menu is drawn here instead, above
 * everything, with a backdrop that closes it.
 */
export function KitProvider({
  colors,
  children,
  style,
  onLayout,
}: {
  colors: Colors;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onLayout?: (width: number) => void;
}) {
  const root = useRef<View>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const api: MenuApi = {
    openId: menu?.id ?? null,
    open(id, trigger, next) {
      if (!trigger || !root.current) return;
      const rootView = root.current;
      trigger.measureInWindow((x, y, width, height) => {
        rootView.measureInWindow((rx, ry) => setMenu({ ...next, id, x: x - rx, y: y - ry, width, height }));
      });
    },
    close: () => setMenu(null),
  };
  const below = menu ? size.height - (menu.y + menu.height) - 8 : 0;
  const upward = menu ? below < Math.min(MENU_MAX_HEIGHT, 32 * menu.options.length + 8) && menu.y > below : false;
  const menuWidth = menu ? Math.max(menu.width, 180) : 0;
  const menuLeft = menu ? (menu.align === "right" ? menu.x + menu.width - menuWidth : menu.x) : 0;
  return (
    <ColorsContext.Provider value={colors}>
      <MenuContext.Provider value={api}>
        <View
          ref={root}
          style={style}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            setSize({ width, height });
            onLayout?.(width);
          }}
        >
          {children}
          {menu ? (
            <>
              <Pressable
                accessibilityLabel="Close menu"
                onPress={() => setMenu(null)}
                style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
              />
              <View
                style={{
                  position: "absolute",
                  left: Math.max(4, Math.min(menuLeft, size.width - menuWidth - 4)),
                  ...(upward ? { bottom: size.height - menu.y + 4 } : { top: menu.y + menu.height + 4 }),
                  minWidth: menuWidth,
                  maxWidth: 440,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface0,
                  paddingVertical: 4,
                  shadowColor: "#000",
                  shadowOpacity: 0.14,
                  shadowRadius: 14,
                  shadowOffset: { width: 0, height: 4 },
                }}
              >
                <ScrollView style={{ maxHeight: Math.min(MENU_MAX_HEIGHT, Math.max(120, upward ? menu.y - 8 : below)) }}>
                  {menu.options.map((option) => {
                    const selected = option.value === menu.value;
                    return (
                      <Pressable
                        key={option.value}
                        accessibilityRole="menuitem"
                        onPress={() => {
                          setMenu(null);
                          if (!selected) menu.onPick(option.value);
                        }}
                        style={({ hovered }: HoverState) => ({
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 6,
                          paddingHorizontal: 10,
                          paddingVertical: 6,
                          backgroundColor: hovered ? colors.surface2 : "transparent",
                        })}
                      >
                        <View style={{ width: 14 }}>
                          {selected ? <Icon name="Check" size={13} color={colors.accent} /> : null}
                        </View>
                        <Text
                          style={{
                            fontSize: FONT.body,
                            color: option.danger ? colors.statusDanger : option.muted ? colors.foregroundMuted : colors.foreground,
                          }}
                        >
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            </>
          ) : null}
        </View>
      </MenuContext.Provider>
    </ColorsContext.Provider>
  );
}

/** Close the open menu, e.g. when the content under it scrolls. */
export function useCloseMenu(): () => void {
  return useContext(MenuContext).close;
}

export function useColors(): Colors {
  const colors = useContext(ColorsContext);
  if (!colors) throw new Error("KitProvider missing");
  return colors;
}

/** `color` at `alpha` (0..1) for tinted backgrounds; falls back to the color itself. */
export function tint(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) return `#${hex[1]}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i.exec(color);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  return color;
}

export const FONT = { small: 11, body: 13, title: 18 } as const;
export const CONTROL_HEIGHT = 28;

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

function toneColor(colors: Colors, tone: Tone): string {
  switch (tone) {
    case "accent":
      return colors.accent;
    case "success":
      return colors.statusSuccess;
    case "warning":
      return colors.statusWarning;
    case "danger":
      return colors.statusDanger;
    default:
      return colors.foregroundMuted;
  }
}

export function Label({
  children,
  muted,
  tone,
  size = FONT.body,
  weight,
  style,
  lines,
  testID,
}: {
  children: ReactNode;
  muted?: boolean;
  tone?: Tone;
  size?: number;
  weight?: TextStyle["fontWeight"];
  style?: StyleProp<TextStyle>;
  lines?: number;
  testID?: string;
}) {
  const colors = useColors();
  const color = tone ? toneColor(colors, tone) : muted ? colors.foregroundMuted : colors.foreground;
  return (
    <Text testID={testID} numberOfLines={lines} style={[{ color, fontSize: size, lineHeight: Math.round(size * 1.4), fontWeight: weight }, style]}>
      {children}
    </Text>
  );
}

export function Badge({ text, tone = "neutral", strong }: { text: string; tone?: Tone; strong?: string }) {
  const colors = useColors();
  const color = toneColor(colors, tone);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: 4,
        paddingHorizontal: 6,
        height: 20,
        borderRadius: 10,
        backgroundColor: tint(color, tone === "neutral" ? 0.12 : 0.14),
      }}
    >
      {strong ? <Text style={{ color: colors.foreground, fontSize: FONT.small, fontWeight: "600" }}>{strong}</Text> : null}
      <Text numberOfLines={1} style={{ color: tone === "neutral" ? colors.foregroundMuted : color, fontSize: FONT.small }}>
        {text}
      </Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  disabled,
  tone = "default",
  icon,
  testID,
}: {
  label: string;
  onPress(): void;
  disabled?: boolean;
  tone?: "default" | "primary" | "danger" | "ghost";
  icon?: string;
  testID?: string;
}) {
  const colors = useColors();
  const primary = tone === "primary";
  const fg = primary ? colors.accentForeground : tone === "danger" ? colors.statusDanger : colors.foreground;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered }: HoverState) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        height: CONTROL_HEIGHT,
        paddingHorizontal: tone === "ghost" ? 6 : 10,
        borderRadius: 6,
        borderWidth: tone === "ghost" || primary ? 0 : 1,
        borderColor: tone === "danger" ? tint(colors.statusDanger, 0.5) : colors.border,
        backgroundColor: primary ? colors.accent : hovered ? colors.surface2 : "transparent",
        opacity: disabled ? 0.45 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={14} color={fg} /> : null}
      <Text style={{ color: fg, fontSize: FONT.body, fontWeight: primary ? "600" : "500" }}>{label}</Text>
    </Pressable>
  );
}

export function IconButton({ name, label, onPress, disabled }: { name: string; label: string; onPress(): void; disabled?: boolean }) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered }: HoverState) => ({
        width: 24,
        height: 24,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 6,
        backgroundColor: hovered ? colors.surface2 : "transparent",
        opacity: disabled ? 0.3 : 1,
      })}
    >
      <Icon name={name} size={14} color={colors.foregroundMuted} />
    </Pressable>
  );
}

let nextMenuId = 0;

/** Compact select: a trigger that opens the provider's menu under (or above) it. */
export function Dropdown<V extends string>({
  value,
  options,
  onChange,
  width,
  disabled,
  warn,
  testID,
  accessibilityLabel,
  variant = "box",
  tone,
}: {
  value: V;
  options: readonly Option<V>[];
  onChange(value: V): void;
  width?: number;
  disabled?: boolean;
  /** Draw the current value in the warning color (missing provider, unknown set). */
  warn?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  /** box: bordered field. quiet: plain text until hovered (table cells). pill: tinted rounded chip. */
  variant?: "box" | "quiet" | "pill";
  /** Text color of the current value. */
  tone?: "accent" | "muted";
}) {
  const colors = useColors();
  const menu = useContext(MenuContext);
  const [id] = useState(() => `menu-${nextMenuId++}`);
  const open = menu.openId === id;
  const box = useRef<View>(null);
  const current = options.find((option) => option.value === value);
  const pill = variant === "pill";
  const quiet = variant === "quiet";
  const text = warn
    ? colors.statusWarning
    : tone === "accent" || pill
      ? colors.accent
      : tone === "muted" || current?.muted
        ? colors.foregroundMuted
        : colors.foreground;

  return (
    <View ref={box} style={{ width, flexShrink: 1 }}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? current?.label}
        disabled={disabled}
        onPress={() =>
          open
            ? menu.close()
            : menu.open(id, box.current, {
                value,
                options,
                onPick: (picked) => onChange(picked as V),
              })
        }
        style={({ hovered }: HoverState) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          height: pill ? 26 : CONTROL_HEIGHT,
          paddingLeft: pill ? 12 : 8,
          paddingRight: pill ? 10 : 6,
          borderRadius: pill ? 13 : 6,
          borderWidth: pill ? 0 : 1,
          borderColor: open ? colors.accent : quiet ? (hovered ? colors.border : "transparent") : hovered ? colors.foregroundMuted : colors.border,
          backgroundColor: pill ? tint(colors.accent, hovered || open ? 0.16 : 0.1) : quiet && !hovered && !open ? "transparent" : colors.surface0,
          opacity: disabled ? 0.5 : 1,
        })}
      >
        {({ hovered }: HoverState) => (
          <>
            <Text
              numberOfLines={1}
              style={{ flexShrink: 1, flexGrow: pill ? 0 : 1, fontSize: FONT.body, fontWeight: pill ? "600" : undefined, color: text }}
            >
              {current?.short ?? current?.label ?? value}
            </Text>
            <Icon
              name="ChevronDown"
              size={13}
              color={quiet && !hovered && !open ? tint(colors.foregroundMuted, 0.5) : pill ? colors.accent : colors.foregroundMuted}
            />
          </>
        )}
      </Pressable>
    </View>
  );
}

/** Text field. `multiline` wraps and grows with its content instead of cutting long text off. */
export function Field({
  value,
  onChangeText,
  placeholder,
  multiline,
  style,
  error,
  disabled,
  testID,
  accessibilityLabel,
  onSubmit,
  autoFocus,
  quiet,
}: {
  value: string;
  onChangeText(text: string): void;
  placeholder?: string;
  multiline?: boolean;
  style?: StyleProp<ViewStyle>;
  error?: boolean;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  onSubmit?: () => void;
  autoFocus?: boolean;
  /** No border until focused (inline text such as a set summary). */
  quiet?: boolean;
}) {
  const colors = useColors();
  const [height, setHeight] = useState(CONTROL_HEIGHT);
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      testID={testID}
      accessibilityLabel={accessibilityLabel ?? placeholder}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.foregroundMuted}
      editable={!disabled}
      multiline={multiline}
      autoFocus={autoFocus}
      onSubmitEditing={onSubmit}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onContentSizeChange={
        multiline ? (event) => setHeight(Math.max(CONTROL_HEIGHT, Math.ceil(event.nativeEvent.contentSize.height) + 2)) : undefined
      }
      style={[
        {
          minHeight: CONTROL_HEIGHT,
          height: multiline ? height : CONTROL_HEIGHT,
          paddingHorizontal: 8,
          paddingVertical: multiline ? 5 : 0,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: error ? colors.statusDanger : focused ? colors.accent : quiet ? "transparent" : colors.border,
          backgroundColor: quiet && !focused ? "transparent" : colors.surface0,
          color: quiet && !focused ? colors.foregroundMuted : colors.foreground,
          fontSize: FONT.body,
          lineHeight: 18,
          // Web only: the focus color is drawn by the border instead.
          outlineStyle: "none",
        } as unknown as TextStyle,
        style as StyleProp<TextStyle>,
      ]}
    />
  );
}

export const TOGGLE = { width: 34, height: 20, thumb: 16 } as const;

/**
 * On/off switch used for every boolean on the screen. role=switch with aria-checked; Space and
 * Enter toggle it. The focus ring shows for keyboard focus only (a click does not leave a ring).
 */
export function Toggle({
  value,
  onChange,
  label,
  disabled,
  testID,
}: {
  value: boolean;
  onChange(value: boolean): void;
  label: string;
  disabled?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  const pointer = useRef(false);
  const [ring, setRing] = useState(false);
  const off = tint(colors.foregroundMuted, 0.38);
  const offHover = tint(colors.foregroundMuted, 0.55);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      {...({ "aria-checked": value } as object)}
      disabled={disabled}
      onPressIn={() => {
        pointer.current = true;
        setRing(false);
      }}
      onPress={() => onChange(!value)}
      onFocus={() => setRing(!pointer.current)}
      onBlur={() => {
        pointer.current = false;
        setRing(false);
      }}
      {...({
        // Space is not a press key for React Native Web's Pressable; Enter is.
        onKeyDown: (event: { key: string; preventDefault(): void }) => {
          if (event.key === " " && !disabled) {
            event.preventDefault();
            onChange(!value);
          }
          pointer.current = false;
          setRing(true);
        },
      } as object)}
      style={({ hovered }: HoverState) =>
        ({
          width: TOGGLE.width,
          height: TOGGLE.height,
          borderRadius: TOGGLE.height / 2,
          padding: (TOGGLE.height - TOGGLE.thumb) / 2,
          justifyContent: "center",
          alignItems: value ? "flex-end" : "flex-start",
          backgroundColor: value ? colors.accent : hovered && !disabled ? offHover : off,
          opacity: disabled ? 0.4 : hovered && value ? 0.88 : 1,
          outlineStyle: "none",
          boxShadow: ring ? `0 0 0 2px ${colors.surface0}, 0 0 0 4px ${tint(colors.accent, 0.55)}` : undefined,
          cursor: disabled ? "not-allowed" : "pointer",
        }) as unknown as ViewStyle
      }
    >
      <View
        style={
          {
            width: TOGGLE.thumb,
            height: TOGGLE.thumb,
            borderRadius: TOGGLE.thumb / 2,
            backgroundColor: "#ffffff",
            boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
          } as unknown as ViewStyle
        }
      />
    </Pressable>
  );
}

/** Space a missing toggle takes, so columns stay aligned. */
export function ToggleSpace() {
  return <View style={{ width: TOGGLE.width, height: TOGGLE.height }} />;
}

/** Rounded bordered card with a heading line. */
export function Panel({
  title,
  hint,
  right,
  children,
  testID,
  style,
}: {
  title: string;
  hint?: string;
  right?: ReactNode;
  children: ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useColors();
  return (
    <View
      testID={testID}
      style={[{ borderWidth: 1, borderColor: colors.border, borderRadius: 14, backgroundColor: colors.surface0 }, style]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap", paddingHorizontal: 18, paddingTop: 14, paddingBottom: 10 }}>
        <Label weight="600" size={14}>
          {title}
        </Label>
        {hint ? (
          <Label muted size={12} style={{ flexShrink: 1 }}>
            {hint}
          </Label>
        ) : null}
        <View style={{ flex: 1 }} />
        {right}
      </View>
      {children}
    </View>
  );
}

/** "•••" button that opens a menu of actions. */
export function MenuButton({
  label,
  actions,
  onPick,
  disabled,
  testID,
}: {
  label: string;
  actions: readonly Option<string>[];
  onPick(action: string): void;
  disabled?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  const menu = useContext(MenuContext);
  const [id] = useState(() => `menu-${nextMenuId++}`);
  const open = menu.openId === id;
  const box = useRef<View>(null);
  return (
    <View ref={box}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={disabled}
        onPress={() => (open ? menu.close() : menu.open(id, box.current, { value: "", options: actions, onPick, align: "right" }))}
        style={({ hovered }: HoverState) => ({
          width: 28,
          height: 28,
          borderRadius: 7,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: open || hovered ? colors.surface2 : "transparent",
          opacity: disabled ? 0.4 : 1,
        })}
      >
        <Text style={{ color: colors.foregroundMuted, fontSize: 13, letterSpacing: 1, lineHeight: 14, marginTop: -4 }}>•••</Text>
      </Pressable>
    </View>
  );
}

/** A titled block: a small heading line (with optional right-side controls) over a bordered card. */
export function Section({
  title,
  hint,
  right,
  children,
  testID,
}: {
  title: string;
  hint?: string;
  right?: ReactNode;
  children: ReactNode;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <View testID={testID} style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap", minHeight: CONTROL_HEIGHT }}>
        <Label weight="600">{title}</Label>
        {hint ? (
          <Label muted size={FONT.small} style={{ flexShrink: 1 }}>
            {hint}
          </Label>
        ) : null}
        <View style={{ flex: 1 }} />
        {right}
      </View>
      <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface0 }}>
        {children}
      </View>
    </View>
  );
}

/** Inline message under or beside the control it belongs to. */
export function Message({ text, tone = "danger" }: { text: string | null | undefined; tone?: Tone }) {
  if (!text) return null;
  return (
    <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start", flexShrink: 1 }}>
      <Label tone={tone} size={12} style={{ flexShrink: 1 }}>
        {text}
      </Label>
    </View>
  );
}
