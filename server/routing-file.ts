import type { Preset, Route, Routing } from "../shared/routing";

// model-routing.md layout owned by this plugin:
// - the `active: <preset>` line,
// - the first table under `## Quick routing` (a copy of the active preset),
// - the whole `## Presets` section (summaries plus one table per preset).
// Everything else in the file is prose for Lead and is left untouched.

const ACTIVE_LINE = /^active:[ \t]*(\S+)[ \t]*$/m;
const QUICK_HEADING = "## Quick routing";
const PRESETS_HEADING = "## Presets";
const TABLE_HEADER = "| Tier | Provider | Model | Effort | Note |";
const TABLE_RULE = "| --- | --- | --- | --- | --- |";

export class RoutingFormatError extends Error {}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/** [start, end) of a `## ` section body, excluding its heading line. */
function sectionRange(lines: string[], heading: string): [number, number] | null {
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("## ")) end += 1;
  return [start + 1, end];
}

function unwrapCode(cell: string): string {
  const trimmed = cell.trim();
  if (trimmed === "-" || trimmed === "") return "";
  const match = /^`([^`]*)`$/.exec(trimmed);
  return match ? match[1] : trimmed;
}

function parseRow(line: string): Route | null {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  if (cells.length !== 5) return null;
  const [tier, provider, model, effort, note] = cells.map((cell) => cell.trim());
  if (tier === "Tier" || /^-+$/.test(tier)) return null;
  return {
    tier: unwrapCode(tier),
    provider: unwrapCode(provider),
    model: unwrapCode(model),
    effort: unwrapCode(effort),
    note: note === "-" ? "" : note,
  };
}

function parseTable(lines: string[], from: number, to: number): Route[] {
  const routes: Route[] = [];
  for (let index = from; index < to; index += 1) {
    const line = lines[index];
    if (!line.trim().startsWith("|")) {
      if (routes.length > 0) break;
      continue;
    }
    const route = parseRow(line);
    if (route) routes.push(route);
  }
  return routes;
}

export function parseRouting(text: string): Routing {
  const lines = splitLines(text);
  const active = ACTIVE_LINE.exec(text.replace(/\r\n/g, "\n"));
  if (!active) throw new RoutingFormatError("No `active:` line.");
  const range = sectionRange(lines, PRESETS_HEADING);
  if (!range) throw new RoutingFormatError("No `## Presets` section.");
  const [from, to] = range;

  const summaries = new Map<string, string>();
  const order: string[] = [];
  for (let index = from; index < to; index += 1) {
    const match = /^- `([^`]+)`:[ \t]*(.*)$/.exec(lines[index]);
    if (match) {
      summaries.set(match[1], match[2].trim());
      order.push(match[1]);
    }
  }

  const tables = new Map<string, Route[]>();
  for (let index = from; index < to; index += 1) {
    const match = /^### `([^`]+)`\s*$/.exec(lines[index]);
    if (!match) continue;
    let end = index + 1;
    while (end < to && !lines[end].startsWith("### ")) end += 1;
    tables.set(match[1], parseTable(lines, index + 1, end));
    if (!order.includes(match[1])) order.push(match[1]);
  }

  const presets: Preset[] = order.map((name) => ({
    name,
    summary: summaries.get(name) ?? "",
    routes: tables.get(name) ?? [],
  }));
  if (presets.length === 0) throw new RoutingFormatError("No presets under `## Presets`.");
  const missing = presets.filter((preset) => preset.routes.length === 0).map((preset) => preset.name);
  if (missing.length > 0) {
    throw new RoutingFormatError(`Preset without a tier table: ${missing.join(", ")}.`);
  }
  if (!presets.some((preset) => preset.name === active[1])) {
    throw new RoutingFormatError(`Active preset \`${active[1]}\` has no table.`);
  }
  return { active: active[1], presets };
}

function cleanCell(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\|/g, "/").trim();
}

function code(value: string): string {
  const cleaned = cleanCell(value).replace(/`/g, "");
  return cleaned ? "`" + cleaned + "`" : "-";
}

export function renderTable(routes: Route[]): string[] {
  return [
    TABLE_HEADER,
    TABLE_RULE,
    ...routes.map((route) =>
      [
        "",
        code(route.tier),
        code(route.provider),
        code(route.model),
        cleanCell(route.effort) || "-",
        cleanCell(route.note) || "-",
        "",
      ].join(" | ").trim(),
    ),
  ];
}

function renderPresets(routing: Routing): string[] {
  const out = [
    "",
    "Switch with the `active:` line above or the Model routing plugin in Paseo.",
    "Quick routing is a copy of the active preset's table; the plugin rewrites it on",
    "save. When editing by hand, change the preset table and Quick routing together.",
    "",
  ];
  for (const preset of routing.presets) {
    out.push(`- \`${preset.name}\`: ${cleanCell(preset.summary)}`.trimEnd());
  }
  for (const preset of routing.presets) {
    out.push("", `### \`${preset.name}\``, "", ...renderTable(preset.routes));
  }
  out.push("");
  return out;
}

/**
 * Contents of a new `model-routing.md`: one set `default` with a `routine` tier that names no
 * provider yet. Providers and models are chosen on the screen, from what the daemon offers.
 */
export function starterRouting(): string {
  const routing: Routing = {
    active: "default",
    presets: [
      {
        name: "default",
        summary: "Starting set. Pick a provider and model for each tier.",
        routes: [{ tier: "routine", provider: "", model: "", effort: "", note: "choose a provider and model" }],
      },
    ],
  };
  const template = [
    "# Model routing",
    "",
    "Routing table for the Model routing plugin. Edit it on the plugin's screen in Paseo or by hand.",
    "",
    "active: default",
    "",
    "## Quick routing",
    "",
    "Lead sees this before creating a Peer. It is a copy of the active set.",
    "",
    TABLE_HEADER,
    "",
    "## Presets",
    "",
  ].join("\n");
  return applyRouting(template, routing);
}

/** Replace the plugin-owned parts of `text` with `routing`; keep all other lines. */
export function applyRouting(text: string, routing: Routing): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const activePreset = routing.presets.find((preset) => preset.name === routing.active);
  if (!activePreset) throw new RoutingFormatError(`Unknown active preset \`${routing.active}\`.`);
  const names = routing.presets.map((preset) => preset.name);
  if (new Set(names).size !== names.length) throw new RoutingFormatError("Duplicate preset name.");
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new RoutingFormatError(`Bad preset name \`${name}\`.`);
  }

  let lines = splitLines(text);
  const activeIndex = lines.findIndex((line) => ACTIVE_LINE.test(line));
  if (activeIndex < 0) throw new RoutingFormatError("No `active:` line.");
  lines[activeIndex] = `active: ${routing.active}`;

  const quick = sectionRange(lines, QUICK_HEADING);
  if (!quick) throw new RoutingFormatError("No `## Quick routing` section.");
  const tableStart = lines.slice(quick[0], quick[1]).findIndex((line) => line.trim().startsWith("|"));
  if (tableStart < 0) throw new RoutingFormatError("No table under `## Quick routing`.");
  const start = quick[0] + tableStart;
  let end = start;
  while (end < quick[1] && lines[end].trim().startsWith("|")) end += 1;
  lines = [...lines.slice(0, start), ...renderTable(activePreset.routes), ...lines.slice(end)];

  const presets = sectionRange(lines, PRESETS_HEADING);
  if (!presets) throw new RoutingFormatError("No `## Presets` section.");
  lines = [...lines.slice(0, presets[0]), ...renderPresets(routing), ...lines.slice(presets[1])];

  return lines.join(eol);
}
