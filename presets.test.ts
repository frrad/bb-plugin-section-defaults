import { test } from "node:test";
import assert from "node:assert/strict";
import { describeChoice, formatOptionSpec, parseOptionSpec, pickChoice } from "./presets.ts";
import type { PresetChoice } from "./presets.ts";

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
