import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createRoutingGuard, type OpenRequest } from "./server/guard";
import {
  createRouting,
  manageSet,
  readRouting,
  readScopes,
  resolveScope,
  ROUTING_FILE,
  saveRouting,
  saveScopes,
  SCOPES_FILE,
} from "./server/handlers";
import { createRoutingRpc, readRoutingRpc, saveRoutingRpc } from "./shared/routing";
import { manageSetRpc, readScopesRpc, resolveScopeRpc, saveScopesRpc } from "./shared/scopes";

export default function contribute(server: PluginServerContext) {
  server.handle(readRoutingRpc, readRouting);
  server.handle(createRoutingRpc, createRouting);
  server.handle(saveRoutingRpc, saveRouting);
  server.handle(readScopesRpc, readScopes);
  server.handle(saveScopesRpc, saveScopes);
  server.handle(resolveScopeRpc, resolveScope);
  server.handle(manageSetRpc, manageSet);

  // Legacy hook names: the 0.14 SDK types know only these; the 0.16.2 host maps them to
  // agent.create.before and agent.open.before (COMPAT until 2027-04-30). The 0.16.2 payloads
  // also carry `metadata`, which the 0.14 types lack.
  const guard = createRoutingGuard({ routingFile: ROUTING_FILE, scopesFile: SCOPES_FILE });
  const stopCreate = server.before("agent.create", ({ request }) => guard.stampCreation(request));
  const stopOpen = server.before("agent.session_open", ({ request }, context) =>
    guard.checkOpen(request as OpenRequest, context),
  );
  return () => {
    stopOpen();
    stopCreate();
  };
}
