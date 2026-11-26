import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import type { RoutingState } from "../shared/routing";
import { createRoutingRpc } from "../shared/routing";
import { errorText } from "./scope-model";
import { Button, Label, Message } from "./ui-kit";

/**
 * First run: `model-routing.md` does not exist yet. Say which file, and offer to create a starting
 * one. The server creates it only if the file is still absent, so it never overwrites.
 */
export function MissingFile({ state, queryKey }: { state: RoutingState; queryKey: readonly unknown[] }) {
  const createRouting = useRpc(createRoutingRpc);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      queryClient.setQueryData(queryKey, await createRouting({}));
    } catch (failure) {
      setError(errorText(failure));
      void queryClient.invalidateQueries({ queryKey });
    } finally {
      setBusy(false);
    }
  }

  return (
    <View testID="missing-file" style={{ padding: 28, gap: 12, maxWidth: 640 }}>
      <Label size={19} weight="600">
        Model routing
      </Label>
      <Label>There is no routing file yet. The plugin looks for it here:</Label>
      <Label testID="missing-file-path" style={{ fontFamily: "monospace" }}>
        {state.path}
      </Label>
      <Label muted>
        Create a starting file with one set and one tier, then choose providers and models on this screen. Or put
        your own model-routing.md at that path, for example a copy of examples/model-routing.md from the plugin,
        and reload. A file that already exists is never overwritten.
      </Label>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button testID="create-routing" tone="primary" label={busy ? "Creating..." : "Create starting file"} disabled={busy} onPress={() => void create()} />
        <Button label="Reload" icon="RefreshCw" tone="ghost" disabled={busy} onPress={() => void queryClient.invalidateQueries({ queryKey })} />
      </View>
      {error ? <Message text={`Not created: ${error}`} /> : null}
    </View>
  );
}
