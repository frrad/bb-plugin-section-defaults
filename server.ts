// bb-plugin-section-defaults — backend entry.
//
// Stores two things per sidebar section in bb.storage.kv: the configured model
// choices, and the settings last used to start a thread from that section
// (project, environment, model). Serves both to the settings page and
// composer banner (app.tsx, over RPC) and to the `bb section-defaults` CLI.
// Every write publishes a realtime signal so open windows pick it up.
import { PluginCliError, cliCommand, defineCli, defineRpcContract } from "@get-bb/plugin-sdk";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PERMISSION_MODES, PRESETS_CHANGED, formatOptionSpec, parseOptionSpec } from "./presets.ts";
import type { PresetConfig, SectionPreset } from "./presets.ts";

const choiceSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  reasoningLevel: z.string().min(1).optional(),
  serviceTier: z.string().min(1).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  weight: z.number().finite().min(0).max(1_000_000),
});
const presetSchema = z.object({ choices: z.array(choiceSchema).max(20) });
const configSchema = z.record(z.string(), presetSchema);
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
const sectionSchema = z.object({ id: z.string(), name: z.string() });

export const rpcContract = defineRpcContract({
  presets_get: {
    input: z.null(),
    output: z.object({
      sections: z.array(sectionSchema),
      projects: z.array(sectionSchema),
      presets: configSchema,
      remembered: rememberedConfigSchema,
      rememberEnabled: z.boolean(),
    }),
  },
  presets_set: {
    input: z.object({ sectionId: z.string().min(1), preset: presetSchema.nullable() }),
    output: z.object({ presets: configSchema }),
  },
  remembered_set: {
    input: z.object({ sectionId: z.string().min(1), remembered: rememberedSchema.nullable() }),
    output: z.object({ remembered: rememberedConfigSchema }),
  },
});

const STORAGE_KEY = "presets";
const REMEMBERED_KEY = "remembered";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    rememberLastUsed: {
      type: "boolean",
      label: "Remember last-used settings per section",
      description:
        "Start each section's new threads in the project, workspace, and model last used from that section. " +
        "Model choices configured below still take priority for the model.",
      default: true,
    },
  });
  settings.onChange(() => bb.realtime.publish(PRESETS_CHANGED, { sectionId: null }));

  async function readPresets(): Promise<PresetConfig> {
    const parsed = configSchema.safeParse(await bb.storage.kv.get(STORAGE_KEY));
    return parsed.success ? parsed.data : {};
  }

  async function writePreset(sectionId: string, preset: SectionPreset | null): Promise<PresetConfig> {
    const presets = await readPresets();
    if (preset === null || preset.choices.length === 0) delete presets[sectionId];
    else presets[sectionId] = preset;
    await bb.storage.kv.set(STORAGE_KEY, presets);
    bb.realtime.publish(PRESETS_CHANGED, { sectionId });
    return presets;
  }

  async function readRemembered(): Promise<RememberedConfig> {
    const parsed = rememberedConfigSchema.safeParse(await bb.storage.kv.get(REMEMBERED_KEY));
    return parsed.success ? parsed.data : {};
  }

  async function writeRemembered(sectionId: string, remembered: Remembered | null): Promise<RememberedConfig> {
    const all = await readRemembered();
    if (remembered === null) delete all[sectionId];
    else all[sectionId] = remembered;
    await bb.storage.kv.set(REMEMBERED_KEY, all);
    bb.realtime.publish(PRESETS_CHANGED, { sectionId });
    return all;
  }

  async function listSections(): Promise<{ id: string; name: string }[]> {
    const sections = await bb.sdk.threadSections.list();
    return sections.map(({ id, name }) => ({ id, name }));
  }

  /** Accepts a section id or its name (case-insensitive). */
  async function resolveSection(query: string): Promise<{ id: string; name: string }> {
    const sections = await listSections();
    const byId = sections.find((section) => section.id === query);
    if (byId !== undefined) return byId;
    const byName = sections.filter((section) => section.name.toLowerCase() === query.toLowerCase());
    if (byName.length === 1 && byName[0] !== undefined) return byName[0];
    throw new PluginCliError(
      byName.length > 1 ? `Several sections are named "${query}"` : `No section "${query}"`,
      {
        code: "section_not_found",
        hint: "Run `bb section-defaults list --all` to see section ids and names.",
      },
    );
  }

  bb.rpc.register(rpcContract, {
    presets_get: async () => ({
      sections: await listSections(),
      projects: (await bb.sdk.projects.list()).map(({ id, name }) => ({ id, name })),
      presets: await readPresets(),
      remembered: await readRemembered(),
      rememberEnabled: (await settings.get()).rememberLastUsed,
    }),
    presets_set: async ({ sectionId, preset }) => ({ presets: await writePreset(sectionId, preset) }),
    remembered_set: async ({ sectionId, remembered }) => {
      if (remembered !== null && !(await settings.get()).rememberLastUsed) return { remembered: await readRemembered() };
      return { remembered: await writeRemembered(sectionId, remembered) };
    },
  });

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
    name: string,
    id: string,
    preset: SectionPreset | undefined,
    remembered: Remembered | undefined,
  ): string {
    const lines = [`${name} (${id})`];
    if (preset === undefined) lines.push("  choices: (none; bb picks the model)");
    else lines.push("  choices:", ...preset.choices.map((choice) => `    ${formatOptionSpec(choice)}`));
    if (remembered !== undefined) lines.push(`  last used: ${formatRemembered(remembered)}`);
    return lines.join("\n");
  }

  bb.cli.register(
    defineCli({
      name: "section-defaults",
      summary: "Per-section defaults for new threads, with weighted random model choice",
      commands: {
        list: cliCommand({
          summary: "Show each section's model choices and last-used settings",
          options: {
            all: { type: "boolean", description: "Include sections with nothing configured or remembered" },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input) {
            const [sections, presets, remembered] = await Promise.all([
              listSections(),
              readPresets(),
              readRemembered(),
            ]);
            const shown = sections.filter(
              (section) =>
                input.options.all || presets[section.id] !== undefined || remembered[section.id] !== undefined,
            );
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  shown.map((section) => ({
                    ...section,
                    preset: presets[section.id] ?? null,
                    remembered: remembered[section.id] ?? null,
                  })),
                ),
              };
            }
            if (shown.length === 0) {
              return { exitCode: 0, stdout: "Nothing configured or remembered yet. Add choices with `bb section-defaults set`." };
            }
            return {
              exitCode: 0,
              stdout: shown
                .map((section) => formatSection(section.name, section.id, presets[section.id], remembered[section.id]))
                .join("\n\n"),
            };
          },
        }),
        set: cliCommand({
          summary: "Replace a section's preset with one or more weighted choices",
          positionals: [{ name: "section", description: "Section id or name", required: true }],
          options: {
            choice: {
              type: "string",
              required: true,
              repeatable: true,
              aliases: ["option", "model"],
              placeholder: "provider/model [reasoning=…] [weight=…] [permission=…] [tier=…]",
              description:
                "One possible model; repeat for a random pick, e.g. --choice 'codex/gpt-sol reasoning=xhigh weight=1'. " +
                "Weight defaults to 1; permission is accept-edits, auto, or full.",
            },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input) {
            const section = await resolveSection(input.positionals.section);
            const specs = input.options.choice;
            let preset: SectionPreset;
            try {
              preset = presetSchema.parse({ choices: specs.map(parseOptionSpec) });
            } catch (cause) {
              throw new PluginCliError(cause instanceof Error ? cause.message : String(cause), {
                code: "invalid_choice",
                hint: "Example: --choice 'claude-code/claude-opus-5-5 reasoning=high weight=1'",
              });
            }
            await writePreset(section.id, preset);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ ...section, preset })
                : formatSection(section.name, section.id, preset, (await readRemembered())[section.id]),
            };
          },
        }),
        clear: cliCommand({
          summary: "Remove a section's model choices (the remembered settings stay)",
          positionals: [{ name: "section", description: "Section id or name", required: true }],
          async run(input) {
            const section = await resolveSection(input.positionals.section);
            await writePreset(section.id, null);
            return { exitCode: 0, stdout: `Cleared ${section.name} (${section.id})` };
          },
        }),
        forget: cliCommand({
          summary: "Forget a section's last-used project, workspace, and model",
          positionals: [{ name: "section", description: "Section id or name", required: true }],
          async run(input) {
            const section = await resolveSection(input.positionals.section);
            await writeRemembered(section.id, null);
            return { exitCode: 0, stdout: `Forgot last-used settings for ${section.name} (${section.id})` };
          },
        }),
      },
    }),
  );
}
