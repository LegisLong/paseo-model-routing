/// <reference types="node" />
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

/**
 * Home of the daemon this process belongs to. The daemon sets `PASEO_HOME` for itself and for the
 * plugin subprocesses and agents it starts, so a daemon started with `--home <dir>` gets `<dir>`.
 * Without it Paseo uses `~/.paseo`; this mirrors that rule, including the `~` prefix.
 */
export function paseoHome(env: Env): string {
  const raw = env.PASEO_HOME || "~/.paseo";
  if (raw === "~") return resolve(homedir());
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return resolve(join(homedir(), raw.slice(2)));
  return resolve(raw);
}

/** Routing file when `PASEO_MODEL_ROUTING_FILE` is not set. */
export function defaultRoutingFile(env: Env): string {
  return join(paseoHome(env), "model-routing.md");
}
