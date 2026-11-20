import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { RoutingScreen } from "./client/routing-screen";

function RoutingItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Route"
      active={currentScreen?.screenId === "model-routing"}
      onPress={() => openScreen({ screenId: "model-routing" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "model-routing", title: "Model routing", Component: RoutingScreen });
  client.addSidebarHeaderItem({ id: "model-routing", title: "Model routing", Component: RoutingItem });
  return () => {};
}
