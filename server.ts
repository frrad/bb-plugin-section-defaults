// bb-plugin-section-defaults — backend entry.
//
// Stores three things in bb.storage.kv:
// - named model presets ("Smart", "Fast"), each a weighted list of models;
// - each section's models: a link to a preset or a one-off list;
// - the settings last used to start a thread from each section (project,
//   environment, model).
// Serves them to the settings page and composer banner (app.tsx, over RPC)
// and to the `bb section-defaults` CLI. Every write publishes a realtime
// signal so open windows pick it up.
import { randomUUID } from "node:crypto";
import { PluginCliError, cliCommand, defineCli, defineRpcContract } from "@get-bb/plugin-sdk";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PERMISSION_MODES, PRESETS_CHANGED, detachPreset, formatOptionSpec, parseOptionSpec } from "./presets.ts";
import type { ModelPreset, ModelPresetConfig, PresetChoice, SectionModels, SectionModelsConfig } from "./presets.ts";

const choiceSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  reasoningLevel: z.string().min(1).optional(),
  serviceTier: z.string().min(1).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  weight: z.number().finite().min(0).max(1_000_000),
});
const choicesSchema = z.array(choiceSchema).max(20);
const presetNameSchema = z.string().trim().min(1).max(60);
const modelPresetSchema = z.object({ name: presetNameSchema, choices: choicesSchema });
const modelPresetConfigSchema = z.record(z.string(), modelPresetSchema);
const sectionModelsSchema = z.union([
  z.object({ presetId: z.string().min(1) }),
  z.object({ choices: choicesSchema }),
]);
const sectionModelsConfigSchema = z.record(z.string(), sectionModelsSchema);
const rememberedSchema = z.object({
  projectId: z.string().min(1).optional(),
  // bb's CreateThreadEnvironmentArgs; passed back to the composer untouched.
  environment: z.json().optional(),
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoningLevel: z.string().min(1).optional(),
  serviceTier: z.string().min(1).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
});
const rememberedConfigSchema = z.record(z.string(), rememberedSchema);
type Remembered = z.infer<typeof rememberedSchema>;
type RememberedConfig = z.infer<typeof rememberedConfigSchema>;
const namedSchema = z.object({ id: z.string(), name: z.string() });
type Named = z.infer<typeof namedSchema>;

export const rpcContract = defineRpcContract({
  state_get: {
    input: z.null(),
    output: z.object({
      sections: z.array(namedSchema),
      projects: z.array(namedSchema),
      modelPresets: modelPresetConfigSchema,
      sectionModels: sectionModelsConfigSchema,
      defaultPresetId: z.string().min(1).nullable(),
      remembered: rememberedConfigSchema,
      rememberEnabled: z.boolean(),
    }),
  },
  section_models_set: {
    input: z.object({ sectionId: z.string().min(1), models: sectionModelsSchema.nullable() }),
    output: z.null(),
  },
  default_preset_set: {
    input: z.object({ id: z.string().min(1).nullable() }),
    output: z.null(),
  },
  model_preset_save: {
    input: z.object({ id: z.string().min(1).nullable(), preset: modelPresetSchema }),
    output: z.object({ id: z.string() }),
  },
  model_preset_delete: {
    input: z.object({ id: z.string().min(1) }),
    output: z.null(),
  },
  remembered_set: {
    input: z.object({ sectionId: z.string().min(1), remembered: rememberedSchema.nullable() }),
    output: z.null(),
  },
});

// "presets" predates named presets; it holds each section's models.
const SECTION_MODELS_KEY = "presets";
const MODEL_PRESETS_KEY = "modelPresets";
const DEFAULT_PRESET_KEY = "defaultPresetId";
const REMEMBERED_KEY = "remembered";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    rememberLastUsed: {
      type: "boolean",
      label: "Remember last-used settings per section",
      description:
        "Start each section's new threads in the project, workspace, and model last used from that section. " +
        "A section's model preset or one-off models still take priority for the model.",
      default: true,
    },
  });
  settings.onChange(() => bb.realtime.publish(PRESETS_CHANGED, {}));

  async function read<T>(key: string, schema: z.ZodType<T>): Promise<T> {
    const parsed = schema.safeParse(await bb.storage.kv.get(key));
    return parsed.success ? parsed.data : schema.parse({});
  }
  async function write(key: string, value: unknown): Promise<void> {
    await bb.storage.kv.set(key, value);
    bb.realtime.publish(PRESETS_CHANGED, {});
  }
  const readModelPresets = (): Promise<ModelPresetConfig> => read(MODEL_PRESETS_KEY, modelPresetConfigSchema);
  const readSectionModels = (): Promise<SectionModelsConfig> => read(SECTION_MODELS_KEY, sectionModelsConfigSchema);
  const readRemembered = (): Promise<RememberedConfig> => read(REMEMBERED_KEY, rememberedConfigSchema);
  const readDefaultPresetId = async (): Promise<string | null> => {
    const parsed = z.string().min(1).nullable().safeParse(await bb.storage.kv.get(DEFAULT_PRESET_KEY));
    return parsed.success ? parsed.data : null;
  };

  async function setSectionModels(sectionId: string, models: SectionModels | null): Promise<void> {
    const all = await readSectionModels();
    if (models !== null && "presetId" in models && (await readModelPresets())[models.presetId] === undefined) {
      throw new Error(`No model preset ${models.presetId}`);
    }
    if (models === null || ("choices" in models && models.choices.length === 0)) delete all[sectionId];
    else all[sectionId] = models;
    await write(SECTION_MODELS_KEY, all);
  }

  /** Creates (id null) or replaces a preset; names are unique, ignoring case. */
  async function saveModelPreset(id: string | null, preset: ModelPreset): Promise<string> {
    const all = await readModelPresets();
    const clash = Object.entries(all).find(
      ([otherId, other]) => otherId !== id && other.name.toLowerCase() === preset.name.toLowerCase(),
    );
    if (clash !== undefined) throw new Error(`A model preset named "${clash[1].name}" already exists`);
    const presetId = id ?? `mp_${randomUUID().slice(0, 8)}`;
    all[presetId] = preset;
    await write(MODEL_PRESETS_KEY, all);
    return presetId;
  }

  async function setDefaultPreset(id: string | null): Promise<void> {
    if (id !== null && (await readModelPresets())[id] === undefined) throw new Error(`No model preset ${id}`);
    await write(DEFAULT_PRESET_KEY, id);
  }

  async function deleteModelPreset(id: string): Promise<void> {
    const all = await readModelPresets();
    const preset = all[id];
    if (preset === undefined) return;
    await write(SECTION_MODELS_KEY, detachPreset(await readSectionModels(), id, preset));
    if (await readDefaultPresetId() === id) await write(DEFAULT_PRESET_KEY, null);
    delete all[id];
    await write(MODEL_PRESETS_KEY, all);
  }

  async function setRemembered(sectionId: string, remembered: Remembered | null): Promise<void> {
    const all = await readRemembered();
    if (remembered === null) delete all[sectionId];
    else all[sectionId] = remembered;
    await write(REMEMBERED_KEY, all);
  }

  async function listSections(): Promise<Named[]> {
    return (await bb.sdk.threadSections.list()).map(({ id, name }) => ({ id, name }));
  }

  /** Accepts an id or a name (case-insensitive). */
  function resolveByIdOrName(kind: string, items: Named[], query: string, hint: string): Named {
    const byId = items.find((item) => item.id === query);
    if (byId !== undefined) return byId;
    const byName = items.filter((item) => item.name.toLowerCase() === query.toLowerCase());
    if (byName.length === 1 && byName[0] !== undefined) return byName[0];
    throw new PluginCliError(byName.length > 1 ? `Several ${kind}s are named "${query}"` : `No ${kind} "${query}"`, {
      code: `${kind.replace(/ /g, "_")}_not_found`,
      hint,
    });
  }
  const resolveSection = async (query: string): Promise<Named> =>
    resolveByIdOrName("section", await listSections(), query, "Run `bb section-defaults list --all` to see sections.");
  const presetList = (presets: ModelPresetConfig): Named[] =>
    Object.entries(presets).map(([id, preset]) => ({ id, name: preset.name }));
  const resolvePreset = async (query: string): Promise<Named> =>
    resolveByIdOrName(
      "model preset",
      presetList(await readModelPresets()),
      query,
      "Run `bb section-defaults preset list` to see presets.",
    );

  bb.rpc.register(rpcContract, {
    state_get: async () => ({
      sections: await listSections(),
      projects: (await bb.sdk.projects.list()).map(({ id, name }) => ({ id, name })),
      modelPresets: await readModelPresets(),
      sectionModels: await readSectionModels(),
      defaultPresetId: await readDefaultPresetId(),
      remembered: await readRemembered(),
      rememberEnabled: (await settings.get()).rememberLastUsed,
    }),
    section_models_set: async ({ sectionId, models }) => {
      await setSectionModels(sectionId, models);
      return null;
    },
    default_preset_set: async ({ id }) => {
      await setDefaultPreset(id);
      return null;
    },
    model_preset_save: async ({ id, preset }) => ({ id: await saveModelPreset(id, preset) }),
    model_preset_delete: async ({ id }) => {
      await deleteModelPreset(id);
      return null;
    },
    remembered_set: async ({ sectionId, remembered }) => {
      if (remembered === null || (await settings.get()).rememberLastUsed) await setRemembered(sectionId, remembered);
      return null;
    },
  });

  // --- CLI -----------------------------------------------------------------

  function parseChoices(specs: readonly string[]): PresetChoice[] {
    try {
      return choicesSchema.parse(specs.map(parseOptionSpec));
    } catch (cause) {
      throw new PluginCliError(cause instanceof Error ? cause.message : String(cause), {
        code: "invalid_choice",
        hint: "Example: --choice 'claude-code/claude-opus-5-5 reasoning=high weight=1'",
      });
    }
  }

  const choiceOption = {
    type: "string",
    required: true,
    repeatable: true,
    aliases: ["option", "model"],
    placeholder: "provider/model [reasoning=…] [weight=…] [permission=…] [tier=…]",
    description:
      "One possible model; repeat for a random pick, e.g. --choice 'codex/gpt-6.1-sol reasoning=xhigh weight=1'. " +
      "Weight defaults to 1; permission is accept-edits, auto, or full.",
  } as const;
  const jsonOption = { type: "boolean", description: "Emit machine-readable JSON" } as const;

  function formatChoices(choices: readonly PresetChoice[], indent: string): string[] {
    return choices.map((choice) => `${indent}${formatOptionSpec(choice)}`);
  }

  function formatRemembered(remembered: Remembered): string {
    const parts = [
      remembered.projectId === undefined ? null : `project=${remembered.projectId}`,
      remembered.environment === undefined ? null : `environment=${JSON.stringify(remembered.environment)}`,
      remembered.model === undefined ? null : `model=${remembered.providerId ?? "?"}/${remembered.model}`,
      remembered.reasoningLevel === undefined ? null : `reasoning=${remembered.reasoningLevel}`,
      remembered.permissionMode === undefined ? null : `permission=${remembered.permissionMode}`,
    ];
    return parts.filter((part): part is string => part !== null).join(" ");
  }

  function formatSection(
    section: Named,
    models: SectionModels | undefined,
    presets: ModelPresetConfig,
    remembered: Remembered | undefined,
    defaultPresetId: string | null,
  ): string {
    const lines = [`${section.name} (${section.id})`];
    if (models === undefined && defaultPresetId !== null) {
      lines.push(`  models: default preset ${presets[defaultPresetId]?.name ?? `${defaultPresetId} (missing)`}`);
    } else if (models === undefined) lines.push("  models: (none; last used or bb's default)");
    else if ("presetId" in models) lines.push(`  models: preset ${presets[models.presetId]?.name ?? `${models.presetId} (missing)`}`);
    else lines.push("  models (one-off):", ...formatChoices(models.choices, "    "));
    if (remembered !== undefined) lines.push(`  last used: ${formatRemembered(remembered)}`);
    return lines.join("\n");
  }

  function formatPreset(id: string, preset: ModelPreset, sections: Named[], links: SectionModelsConfig): string {
    const users = sections.filter((section) => {
      const models = links[section.id];
      return models !== undefined && "presetId" in models && models.presetId === id;
    });
    return [
      `${preset.name} (${id})${users.length === 0 ? "" : ` · used by ${users.map((section) => section.name).join(", ")}`}`,
      ...formatChoices(preset.choices, "  "),
    ].join("\n");
  }

  async function describeSection(section: Named): Promise<string> {
    const [models, presets, remembered, defaultPresetId] = await Promise.all([
      readSectionModels(), readModelPresets(), readRemembered(), readDefaultPresetId(),
    ]);
    return formatSection(section, models[section.id], presets, remembered[section.id], defaultPresetId);
  }

  bb.cli.register(
    defineCli({
      name: "section-defaults",
      summary: "Per-section defaults for new threads: last-used workspace, and models from shared presets",
      commands: {
        list: cliCommand({
          summary: "Show each section's models and last-used settings",
          options: {
            all: { type: "boolean", description: "Include sections with nothing configured or remembered" },
            json: jsonOption,
          },
          async run(input) {
            const [sections, models, presets, remembered, defaultPresetId] = await Promise.all([
              listSections(),
              readSectionModels(),
              readModelPresets(),
              readRemembered(),
              readDefaultPresetId(),
            ]);
            const shown = sections.filter(
              (section) =>
                input.options.all || models[section.id] !== undefined || remembered[section.id] !== undefined,
            );
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  shown.map((section) => ({
                    ...section,
                    models: models[section.id] ?? null,
                    remembered: remembered[section.id] ?? null,
                  })),
                ),
              };
            }
            if (shown.length === 0) {
              return { exitCode: 0, stdout: "Nothing configured or remembered yet. See `bb section-defaults --help`." };
            }
            return {
              exitCode: 0,
              stdout: shown
                .map((section) => formatSection(section, models[section.id], presets, remembered[section.id], defaultPresetId))
                .join("\n\n"),
            };
          },
        }),
        "default set": cliCommand({
          summary: "Use a preset for every section without its own models",
          positionals: [{ name: "preset", description: "Model preset id or name", required: true }],
          async run(input) {
            const preset = await resolvePreset(input.positionals.preset);
            await setDefaultPreset(preset.id);
            return { exitCode: 0, stdout: `Default preset: ${preset.name} (${preset.id})` };
          },
        }),
        "default clear": cliCommand({
          summary: "Stop applying a default preset to sections without their own models",
          async run() {
            await setDefaultPreset(null);
            return { exitCode: 0, stdout: "Cleared the default preset" };
          },
        }),
        use: cliCommand({
          summary: "Link a section to a model preset; later edits to the preset apply to it",
          positionals: [
            { name: "section", description: "Section id or name", required: true },
            { name: "preset", description: "Model preset id or name", required: true },
          ],
          async run(input) {
            const section = await resolveSection(input.positionals.section);
            const preset = await resolvePreset(input.positionals.preset);
            await setSectionModels(section.id, { presetId: preset.id });
            return { exitCode: 0, stdout: await describeSection(section) };
          },
        }),
        set: cliCommand({
          summary: "Give a section its own one-off list of weighted models (unlinks any preset)",
          positionals: [{ name: "section", description: "Section id or name", required: true }],
          options: { choice: choiceOption, json: jsonOption },
          async run(input) {
            const section = await resolveSection(input.positionals.section);
            const models = { choices: parseChoices(input.options.choice) };
            await setSectionModels(section.id, models);
            return {
              exitCode: 0,
              stdout: input.options.json ? JSON.stringify({ ...section, models }) : await describeSection(section),
            };
          },
        }),
        clear: cliCommand({
          summary: "Remove a section's models, preset or one-off (the remembered settings stay)",
          positionals: [{ name: "section", description: "Section id or name", required: true }],
          async run(input) {
            const section = await resolveSection(input.positionals.section);
            await setSectionModels(section.id, null);
            return { exitCode: 0, stdout: `Cleared models for ${section.name} (${section.id})` };
          },
        }),
        forget: cliCommand({
          summary: "Forget a section's last-used project, workspace, and model",
          positionals: [{ name: "section", description: "Section id or name", required: true }],
          async run(input) {
            const section = await resolveSection(input.positionals.section);
            await setRemembered(section.id, null);
            return { exitCode: 0, stdout: `Forgot last-used settings for ${section.name} (${section.id})` };
          },
        }),
        "preset list": cliCommand({
          summary: "Show model presets and the sections using each",
          options: { json: jsonOption },
          async run(input) {
            const [presets, sections, links] = await Promise.all([readModelPresets(), listSections(), readSectionModels()]);
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(presets) };
            const entries = Object.entries(presets);
            if (entries.length === 0) {
              return { exitCode: 0, stdout: "No model presets. Create one with `bb section-defaults preset set`." };
            }
            return {
              exitCode: 0,
              stdout: entries.map(([id, preset]) => formatPreset(id, preset, sections, links)).join("\n\n"),
            };
          },
        }),
        "preset set": cliCommand({
          summary: "Create a model preset, or replace an existing one's models (sections using it follow)",
          positionals: [{ name: "name", description: "Preset name, e.g. Smart", required: true }],
          options: { choice: choiceOption },
          async run(input) {
            const name = presetNameSchema.parse(input.positionals.name);
            const presets = await readModelPresets();
            const existing = presetList(presets).find((preset) => preset.name.toLowerCase() === name.toLowerCase());
            const preset = { name: existing?.name ?? name, choices: parseChoices(input.options.choice) };
            const id = await saveModelPreset(existing?.id ?? null, preset);
            return { exitCode: 0, stdout: formatPreset(id, preset, await listSections(), await readSectionModels()) };
          },
        }),
        "preset rename": cliCommand({
          summary: "Rename a model preset",
          positionals: [
            { name: "preset", description: "Preset id or name", required: true },
            { name: "name", description: "New name", required: true },
          ],
          async run(input) {
            const found = await resolvePreset(input.positionals.preset);
            const presets = await readModelPresets();
            const current = presets[found.id];
            if (current === undefined) throw new PluginCliError(`No model preset "${input.positionals.preset}"`);
            await saveModelPreset(found.id, { ...current, name: presetNameSchema.parse(input.positionals.name) });
            return { exitCode: 0, stdout: `Renamed ${current.name} to ${input.positionals.name.trim()}` };
          },
        }),
        "preset delete": cliCommand({
          summary: "Delete a model preset; sections using it keep a one-off copy of its models",
          positionals: [{ name: "preset", description: "Preset id or name", required: true }],
          async run(input) {
            const found = await resolvePreset(input.positionals.preset);
            await deleteModelPreset(found.id);
            return { exitCode: 0, stdout: `Deleted model preset ${found.name}` };
          },
        }),
      },
    }),
  );
}
