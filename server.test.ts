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

test("state_get reports providers out of capacity, and survives usage failures", async () => {
  let calls = 0;
  let fail = false;
  const { bb, harness } = createFakePluginHost({
    pluginId: "section-defaults",
    sdk: {
      threadSections: { list: async () => [] },
      projects: { list: async () => [] },
      system: {
        usageLimits: async () => {
          calls++;
          if (fail) throw new Error("host offline");
          return {
            codex: { status: "ok", accountEmail: null, planLabel: null, windows: [
              { label: "Weekly limit", usedPercent: 100, resetsAt: "2999-01-01T00:00:00.000Z" },
            ] },
            "claude-code": { status: "unauthenticated" },
          };
        },
      },
    },
  });
  try {
    await plugin(bb);
    type State = { exhaustedProviders: Record<string, unknown> };
    const expected = { codex: { label: "Weekly limit", resetsAt: "2999-01-01T00:00:00.000Z" } };
    let state = await harness.behavior.callRpc("state_get", null) as State;
    assert.deepEqual(state.exhaustedProviders, expected);
    fail = true;
    state = await harness.behavior.callRpc("state_get", null) as State;
    assert.deepEqual(state.exhaustedProviders, expected); // cached reading
    assert.equal(calls, 1);
  } finally {
    await harness.lifecycle.dispose();
  }
});
