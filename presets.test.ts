import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSelection,
  describeChoice,
  detachPreset,
  formatOptionSpec,
  parseOptionSpec,
  pickChoice,
  resolveSectionModels,
} from "./presets.ts";
import type { ModelPreset, PresetChoice, Remembered, SectionModelsConfig } from "./presets.ts";

const opus: PresetChoice = {
  providerId: "claude-code",
  model: "claude-opus-5-5",
  reasoningLevel: "high",
  weight: 1,
};
const sol: PresetChoice = {
  providerId: "codex",
  model: "gpt-sol",
  reasoningLevel: "xhigh",
  weight: 3,
};

test("pickChoice returns null for an empty list", () => {
  assert.equal(pickChoice([], () => 0), null);
});

test("pickChoice always returns the only choice", () => {
  assert.equal(pickChoice([opus], () => 0.999), opus);
});

test("pickChoice splits the unit interval by weight", () => {
  // Total weight 4: opus owns [0, 0.25), sol owns [0.25, 1).
  assert.equal(pickChoice([opus, sol], () => 0), opus);
  assert.equal(pickChoice([opus, sol], () => 0.2499), opus);
  assert.equal(pickChoice([opus, sol], () => 0.25), sol);
  assert.equal(pickChoice([opus, sol], () => 0.9999), sol);
});

test("pickChoice skips zero-weight choices", () => {
  const off: PresetChoice = { ...opus, weight: 0 };
  assert.equal(pickChoice([off, sol], () => 0), sol);
});

test("describeChoice shows model, reasoning, and odds", () => {
  assert.equal(describeChoice(opus, [opus, sol]), "claude-opus-5-5 · high · 25%");
  assert.equal(describeChoice(sol, [sol]), "gpt-sol · xhigh");
});

test("parseOptionSpec reads provider/model and optional fields", () => {
  assert.deepEqual(parseOptionSpec("codex/gpt-sol"), {
    providerId: "codex",
    model: "gpt-sol",
    weight: 1,
  });
  assert.deepEqual(
    parseOptionSpec("claude-code/claude-opus-5-5 reasoning=high weight=50 permission=full tier=fast"),
    {
      providerId: "claude-code",
      model: "claude-opus-5-5",
      reasoningLevel: "high",
      weight: 50,
      permissionMode: "full",
      serviceTier: "fast",
    },
  );
});

test("parseOptionSpec accepts commas between fields", () => {
  assert.deepEqual(parseOptionSpec("codex/gpt-sol,reasoning=xhigh,weight=2"), {
    providerId: "codex",
    model: "gpt-sol",
    reasoningLevel: "xhigh",
    weight: 2,
  });
});

test("parseOptionSpec rejects malformed input", () => {
  assert.throws(() => parseOptionSpec("gpt-sol"), /provider\/model/);
  assert.throws(() => parseOptionSpec("codex/"), /provider\/model/);
  assert.throws(() => parseOptionSpec("codex/gpt-sol weight=-1"), /weight/);
  assert.throws(() => parseOptionSpec("codex/gpt-sol weight=abc"), /weight/);
  assert.throws(() => parseOptionSpec("codex/gpt-sol permission=yolo"), /permission/);
  assert.throws(() => parseOptionSpec("codex/gpt-sol colour=red"), /colour/);
});

test("formatOptionSpec round-trips through parseOptionSpec", () => {
  const choice: PresetChoice = { ...opus, weight: 50, permissionMode: "full" };
  assert.deepEqual(parseOptionSpec(formatOptionSpec(choice)), choice);
});

test("buildSelection returns null with nothing to apply", () => {
  assert.equal(buildSelection(undefined, null), null);
});

test("buildSelection restores the remembered project, environment, and model", () => {
  const remembered: Remembered = {
    projectId: "proj_1",
    environment: { type: "provider", environmentProviderId: "worktree", inputs: null },
    providerId: "codex",
    model: "gpt-6-luna",
    reasoningLevel: "low",
    permissionMode: "full",
  };
  assert.deepEqual(buildSelection(remembered, null), {
    projectId: "proj_1",
    environment: { type: "provider", environmentProviderId: "worktree", inputs: null },
    providerId: "codex",
    model: "gpt-6-luna",
    reasoningLevel: "low",
    permissionMode: "full",
  });
});

test("buildSelection lets the rolled choice replace the remembered model fields", () => {
  const remembered: Remembered = {
    projectId: "proj_1",
    providerId: "codex",
    model: "gpt-6-luna",
    reasoningLevel: "low",
    serviceTier: "fast",
    permissionMode: "full",
  };
  // The remembered tier belonged to the remembered model, so it goes too; the
  // permission mode is kept because the choice does not set one.
  assert.deepEqual(buildSelection(remembered, opus), {
    projectId: "proj_1",
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "high",
    permissionMode: "full",
  });
  assert.deepEqual(buildSelection(remembered, { ...opus, permissionMode: "auto" })?.permissionMode, "auto");
});

test("buildSelection with only a choice sets just the model fields", () => {
  assert.deepEqual(buildSelection(undefined, { ...sol, permissionMode: "auto" }), {
    providerId: "codex",
    model: "gpt-sol",
    reasoningLevel: "xhigh",
    permissionMode: "auto",
  });
});

test("buildSelection never restores a reused environment", () => {
  const remembered: Remembered = {
    projectId: "proj_1",
    environment: { type: "reuse", environmentId: "env_gone" },
  };
  assert.deepEqual(buildSelection(remembered, null), { projectId: "proj_1" });
});

const smart: ModelPreset = { name: "Smart", choices: [opus, sol] };

test("resolveSectionModels follows a linked preset", () => {
  assert.deepEqual(resolveSectionModels({ presetId: "mp_smart" }, { mp_smart: smart }), {
    choices: [opus, sol],
    presetName: "Smart",
  });
});

test("resolveSectionModels sees edits to the linked preset", () => {
  const edited: ModelPreset = { name: "Smart", choices: [sol] };
  assert.deepEqual(resolveSectionModels({ presetId: "mp_smart" }, { mp_smart: edited })?.choices, [sol]);
});

test("resolveSectionModels returns a section's one-off choices", () => {
  assert.deepEqual(resolveSectionModels({ choices: [opus] }, { mp_smart: smart }), {
    choices: [opus],
    presetName: null,
  });
});

test("resolveSectionModels returns null with no models or a missing preset", () => {
  assert.equal(resolveSectionModels(undefined, { mp_smart: smart }), null);
  assert.equal(resolveSectionModels({ presetId: "mp_gone" }, { mp_smart: smart }), null);
  assert.equal(resolveSectionModels({ choices: [] }, {}), null);
});

test("detachPreset turns sections linked to a preset into one-off copies", () => {
  const sections: SectionModelsConfig = {
    sec_a: { presetId: "mp_smart" },
    sec_b: { presetId: "mp_fast" },
    sec_c: { choices: [sol] },
  };
  assert.deepEqual(detachPreset(sections, "mp_smart", smart), {
    sec_a: { choices: [opus, sol] },
    sec_b: { presetId: "mp_fast" },
    sec_c: { choices: [sol] },
  });
});
