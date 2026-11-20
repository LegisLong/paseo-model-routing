import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const routeSchema = z.object({
  tier: z.string().min(1),
  provider: z.string(),
  model: z.string(),
  effort: z.string(),
  note: z.string(),
});

export const presetSchema = z.object({
  name: z.string().min(1),
  summary: z.string(),
  routes: z.array(routeSchema),
});

export const routingSchema = z.object({
  active: z.string().min(1),
  presets: z.array(presetSchema),
});

export const thinkingOptionSchema = z.object({ id: z.string(), label: z.string() });

export const modelOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  efforts: z.array(thinkingOptionSchema),
});

export const providerOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  models: z.array(modelOptionSchema),
  /**
   * Whether `models` is the provider's catalogue: `loading` while the daemon is still discovering it,
   * `unavailable` when discovery failed or the provider is off. Absent means ready.
   */
  modelsStatus: z.enum(["ready", "loading", "unavailable"]).optional(),
});

export const routingStateSchema = z.object({
  path: z.string(),
  revision: z.string(),
  routing: routingSchema.nullable(),
  parseError: z.string().nullable(),
  providers: z.array(providerOptionSchema),
  providersError: z.string().nullable(),
});

export type Route = z.infer<typeof routeSchema>;
export type Preset = z.infer<typeof presetSchema>;
export type Routing = z.infer<typeof routingSchema>;
export type ProviderOption = z.infer<typeof providerOptionSchema>;
export type RoutingState = z.infer<typeof routingStateSchema>;

export const readRoutingRpc = defineRpc({
  name: "routing.read",
  input: z.object({}),
  output: routingStateSchema,
});

export const saveRoutingRpc = defineRpc({
  name: "routing.save",
  input: z.object({ revision: z.string(), routing: routingSchema }),
  output: routingStateSchema,
});

/** No provider in the route: tiers such as `review` that name several models in the note. */
export const NO_PROVIDER = "";

/**
 * Optional tier in any preset: the provider/model/effort a Supervisor uses to create a Lead.
 * Every other tier is a Peer route for Lead.
 */
export const LEAD_TIER = "lead";

/** Preset names the md editor accepts (also the `active:` line and scope references). */
export const PRESET_NAME = /^[A-Za-z0-9_-]+$/;

/** DeepSeek on Mistral rejects `medium` although Paseo lists it. */
export function allowedEffort(provider: string, effort: string): boolean {
  return !(provider.startsWith("deepseek-") && effort === "medium");
}
