// bb-plugin-section-defaults — backend entry.
//
// Stores one preset per sidebar section in bb.storage.kv and serves it to the
// settings page and composer banner (app.tsx, over RPC) and to the
// `bb section-defaults` CLI. Every write publishes a realtime signal so open
// windows pick it up.
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
const sectionSchema = z.object({ id: z.string(), name: z.string() });

export const rpcContract = defineRpcContract({
  presets_get: {
    input: z.null(),
    output: z.object({ sections: z.array(sectionSchema), presets: configSchema }),
  },
  presets_set: {
    input: z.object({ sectionId: z.string().min(1), preset: presetSchema.nullable() }),
    output: z.object({ presets: configSchema }),
  },
});

const STORAGE_KEY = "presets";

export default async function plugin(bb: BbPluginApi): Promise<void> {
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
    presets_get: async () => ({ sections: await listSections(), presets: await readPresets() }),
    presets_set: async ({ sectionId, preset }) => ({ presets: await writePreset(sectionId, preset) }),
  });

  function formatPreset(name: string, id: string, preset: SectionPreset | undefined): string {
    const header = `${name} (${id})`;
    if (preset === undefined) return `${header}\n  (bb defaults)`;
    return [header, ...preset.choices.map((choice) => `  ${formatOptionSpec(choice)}`)].join("\n");
  }

  bb.cli.register(
    defineCli({
      name: "section-defaults",
      summary: "Per-section defaults for new threads, with weighted random model choice",
      commands: {
        list: cliCommand({
          summary: "Show each section's preset",
          options: {
            all: { type: "boolean", description: "Include sections that have no preset" },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input) {
            const [sections, presets] = await Promise.all([listSections(), readPresets()]);
            const shown = sections.filter((section) => input.options.all || presets[section.id] !== undefined);
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify(shown.map((section) => ({ ...section, preset: presets[section.id] ?? null }))),
              };
            }
            if (shown.length === 0) {
              return { exitCode: 0, stdout: "No section presets. Add one with `bb section-defaults set`." };
            }
            return {
              exitCode: 0,
              stdout: shown.map((section) => formatPreset(section.name, section.id, presets[section.id])).join("\n\n"),
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
                : formatPreset(section.name, section.id, preset),
            };
          },
        }),
        clear: cliCommand({
          summary: "Remove a section's preset so it uses bb's defaults again",
          positionals: [{ name: "section", description: "Section id or name", required: true }],
          async run(input) {
            const section = await resolveSection(input.positionals.section);
            await writePreset(section.id, null);
            return { exitCode: 0, stdout: `Cleared ${section.name} (${section.id})` };
          },
        }),
      },
    }),
  );
}
