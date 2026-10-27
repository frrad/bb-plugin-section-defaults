import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

test("the default preset is validated and cleared when its preset is deleted", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "section-defaults",
    sdk: {
      threadSections: { list: async () => [] },
      projects: { list: async () => [] },
    },
  });
  try {
    await plugin(bb);
    const preset = {
      name: "Smart",
      choices: [{ providerId: "claude-code", model: "opus", weight: 1 }],
    };
    const { id } = await harness.behavior.callRpc("model_preset_save", { id: null, preset }) as { id: string };
    await assert.rejects(harness.behavior.callRpc("default_preset_set", { id: "mp_missing" }), /No model preset/);

    await harness.behavior.callRpc("default_preset_set", { id });
    let state = await harness.behavior.callRpc("state_get", null) as { defaultPresetId: string | null };
    assert.equal(state.defaultPresetId, id);

    await harness.behavior.callRpc("model_preset_delete", { id });
    state = await harness.behavior.callRpc("state_get", null) as { defaultPresetId: string | null };
    assert.equal(state.defaultPresetId, null);
  } finally {
    await harness.lifecycle.dispose();
  }
});
