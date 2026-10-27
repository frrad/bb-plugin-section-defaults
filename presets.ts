// Shared by server.ts (storage, CLI) and app.tsx (settings page, composer
// banner). Plain TypeScript with no runtime imports, so both bundles and the
// node tests can use it.

/** Realtime channel the server publishes on after every preset write. */
export const PRESETS_CHANGED = "presets-changed";

export const PERMISSION_MODES = ["accept-edits", "auto", "full"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** One model a section can start a thread with. Reasoning belongs to the model. */
export interface PresetChoice {
  providerId: string;
  model: string;
  reasoningLevel?: string;
  serviceTier?: string;
  permissionMode?: PermissionMode;
  /** Relative odds against the section's other choices; 0 disables the choice. */
  weight: number;
}

/** A named, reusable list of model choices, e.g. "Smart" or "Fast". */
export interface ModelPreset {
  name: string;
  choices: PresetChoice[];
}

/** Preset id → preset. */
export type ModelPresetConfig = Record<string, ModelPreset>;

/**
 * A section's models: a link to a shared preset (edits to the preset reach
 * every section using it) or the section's own one-off list.
 */
export type SectionModels = { presetId: string } | { choices: PresetChoice[] };

/** Section id → models. Sections without an entry can inherit the global default preset. */
export type SectionModelsConfig = Record<string, SectionModels>;

/** The choices a section rolls from, and the preset they come from (null for a one-off list). */
export function resolveSectionModels(
  section: SectionModels | undefined,
  presets: ModelPresetConfig,
  defaultPresetId?: string | null,
): { choices: PresetChoice[]; presetName: string | null } | null {
  if (section === undefined) {
    if (defaultPresetId == null) return null;
    section = { presetId: defaultPresetId };
  }
  if ("presetId" in section) {
    const preset = presets[section.presetId];
    return preset === undefined || preset.choices.length === 0
      ? null
      : { choices: preset.choices, presetName: preset.name };
  }
  return section.choices.length === 0 ? null : { choices: section.choices, presetName: null };
}

/** Before a preset is deleted: sections linked to it keep a one-off copy of its choices. */
export function detachPreset(
  sections: SectionModelsConfig,
  presetId: string,
  preset: ModelPreset,
): SectionModelsConfig {
  return Object.fromEntries(
    Object.entries(sections).map(([sectionId, models]) => [
      sectionId,
      "presetId" in models && models.presetId === presetId ? { choices: [...preset.choices] } : models,
    ]),
  );
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * What the new-thread composer last submitted from a section: project,
 * environment (bb's `CreateThreadEnvironmentArgs`, kept opaque), and model
 * settings. Restored the next time that section's `+` is pressed.
 */
export interface Remembered {
  projectId?: string;
  environment?: Json;
  providerId?: string;
  model?: string;
  reasoningLevel?: string;
  serviceTier?: string;
  permissionMode?: PermissionMode;
}

/** Section id → last-used settings. */
export type RememberedConfig = Record<string, Remembered>;

/** The fields of `setSelection` this plugin fills in. */
export interface SelectionPatch {
  projectId?: string;
  environment?: unknown;
  providerId?: string;
  model?: string;
  reasoningLevel?: string;
  serviceTier?: string;
  permissionMode?: PermissionMode;
}

function isReusedEnvironment(environment: unknown): boolean {
  return typeof environment === "object" && environment !== null && "type" in environment &&
    environment.type === "reuse";
}

/**
 * Combines a section's remembered settings with a rolled model choice. The
 * choice wins for provider, model, reasoning, and tier; permission falls back
 * to the remembered one. A reused environment is never restored: it pins the
 * thread to one old worktree.
 */
export function buildSelection(
  remembered: Remembered | undefined,
  choice: PresetChoice | null,
): SelectionPatch | null {
  const patch: SelectionPatch = {};
  if (remembered !== undefined) {
    if (remembered.projectId !== undefined) patch.projectId = remembered.projectId;
    if (remembered.environment !== undefined && !isReusedEnvironment(remembered.environment)) {
      patch.environment = remembered.environment;
    }
    if (choice === null) {
      if (remembered.providerId !== undefined) patch.providerId = remembered.providerId;
      if (remembered.model !== undefined) patch.model = remembered.model;
      if (remembered.reasoningLevel !== undefined) patch.reasoningLevel = remembered.reasoningLevel;
      if (remembered.serviceTier !== undefined) patch.serviceTier = remembered.serviceTier;
    }
    if (remembered.permissionMode !== undefined) patch.permissionMode = remembered.permissionMode;
  }
  if (choice !== null) {
    patch.providerId = choice.providerId;
    patch.model = choice.model;
    if (choice.reasoningLevel !== undefined) patch.reasoningLevel = choice.reasoningLevel;
    if (choice.serviceTier !== undefined) patch.serviceTier = choice.serviceTier;
    if (choice.permissionMode !== undefined) patch.permissionMode = choice.permissionMode;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/** Weighted random pick. `random` returns a number in [0, 1). */
export function pickChoice(
  choices: readonly PresetChoice[],
  random: () => number = Math.random,
): PresetChoice | null {
  const live = choices.filter((choice) => choice.weight > 0);
  const total = live.reduce((sum, choice) => sum + choice.weight, 0);
  if (total <= 0) return null;
  let remaining = random() * total;
  for (const choice of live) {
    remaining -= choice.weight;
    if (remaining < 0) return choice;
  }
  return live[live.length - 1] ?? null;
}

/** Percent chance of `choice` among `choices`, rounded; null when it is the only live one. */
export function choiceOdds(choice: PresetChoice, choices: readonly PresetChoice[]): number | null {
  const live = choices.filter((candidate) => candidate.weight > 0);
  if (live.length <= 1) return null;
  const total = live.reduce((sum, candidate) => sum + candidate.weight, 0);
  return Math.round((choice.weight / total) * 100);
}

export function describeChoice(choice: PresetChoice, choices: readonly PresetChoice[]): string {
  const odds = choiceOdds(choice, choices);
  return [choice.model, choice.reasoningLevel, odds === null ? undefined : `${odds}%`]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");
}

const SPEC_FIELDS = ["reasoning", "weight", "permission", "tier"] as const;
type SpecField = (typeof SPEC_FIELDS)[number];

/**
 * Parses the CLI's `--choice` value: `provider/model` followed by optional
 * `key=value` fields separated by spaces or commas, e.g.
 * `codex/gpt-sol reasoning=xhigh weight=50 permission=full tier=fast`.
 */
export function parseOptionSpec(spec: string): PresetChoice {
  const [head = "", ...fields] = spec.trim().split(/[\s,]+/);
  const slash = head.indexOf("/");
  const providerId = head.slice(0, slash);
  const model = head.slice(slash + 1);
  if (slash <= 0 || model === "") {
    throw new Error(`Expected provider/model at the start of "${spec}", e.g. codex/gpt-sol`);
  }
  const choice: PresetChoice = { providerId, model, weight: 1 };
  for (const field of fields) {
    const equals = field.indexOf("=");
    const key = field.slice(0, equals);
    const value = field.slice(equals + 1);
    if (equals <= 0 || value === "" || !SPEC_FIELDS.includes(key as SpecField)) {
      throw new Error(`Unknown field "${field}"; use ${SPEC_FIELDS.map((name) => `${name}=…`).join(", ")}`);
    }
    switch (key as SpecField) {
      case "reasoning":
        choice.reasoningLevel = value;
        break;
      case "tier":
        choice.serviceTier = value;
        break;
      case "weight": {
        const weight = Number(value);
        if (!Number.isFinite(weight) || weight < 0) {
          throw new Error(`weight must be a non-negative number, got "${value}"`);
        }
        choice.weight = weight;
        break;
      }
      case "permission":
        if (!PERMISSION_MODES.includes(value as PermissionMode)) {
          throw new Error(`permission must be one of ${PERMISSION_MODES.join(", ")}, got "${value}"`);
        }
        choice.permissionMode = value as PermissionMode;
        break;
    }
  }
  return choice;
}

/** The inverse of parseOptionSpec, for listing presets in CLI output. */
export function formatOptionSpec(choice: PresetChoice): string {
  return [
    `${choice.providerId}/${choice.model}`,
    choice.reasoningLevel === undefined ? null : `reasoning=${choice.reasoningLevel}`,
    `weight=${choice.weight}`,
    choice.permissionMode === undefined ? null : `permission=${choice.permissionMode}`,
    choice.serviceTier === undefined ? null : `tier=${choice.serviceTier}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}
