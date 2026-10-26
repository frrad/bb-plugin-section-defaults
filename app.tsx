// bb-plugin-section-defaults — frontend entry.
//
// Two surfaces:
//
// - A banner on the new-thread composer. When the screen was opened from a
//   sidebar section's `+` button, it restores the project, workspace, and
//   model last used from that section, then, if the section has model
//   choices, picks one (weighted at random) for the model. The banner says
//   what it did and can re-roll. Sending from the composer records the
//   settings for next time. See placement.ts for how the section is detected.
// - A settings page (Settings → Section Defaults) that edits each section's
//   choices with bb's own provider/model and permission pickers and shows
//   what each section remembers.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_PermissionModePicker as PermissionModePicker,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useComposer,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { ComposerSelection } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { readNavigationKey, readPlacementSectionId } from "./placement.ts";
import { selectWorktreeBranch, worktreeBranch } from "./worktree-branch.ts";
import { PRESETS_CHANGED, buildSelection, choiceOdds, describeChoice, pickChoice } from "./presets.ts";
import type {
  Json,
  PresetChoice,
  PresetConfig,
  Remembered,
  RememberedConfig,
  SectionPreset,
  SelectionPatch,
} from "./presets.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

/** How often the banner rechecks which section the new-thread screen belongs to. */
const PLACEMENT_POLL_MS = 200;
/** Remembers which visit to the new-thread screen was already rolled, across reloads. */
const APPLIED_KEY = "section-defaults.applied";

interface Section {
  id: string;
  name: string;
}

function usePresets(): {
  sections: Section[];
  projects: Section[];
  presets: PresetConfig | null;
  remembered: RememberedConfig;
  rememberEnabled: boolean;
  save: (sectionId: string, preset: SectionPreset | null) => Promise<void>;
  saveRemembered: (sectionId: string, remembered: Remembered | null) => Promise<void>;
  error: string | null;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [sections, setSections] = useState<Section[]>([]);
  const [projects, setProjects] = useState<Section[]>([]);
  const [presets, setPresets] = useState<PresetConfig | null>(null);
  const [remembered, setRemembered] = useState<RememberedConfig>({});
  const [rememberEnabled, setRememberEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("presets_get").then((result) => {
      setSections(result.sections);
      setProjects(result.projects);
      setPresets(result.presets);
      setRemembered(result.remembered);
      setRememberEnabled(result.rememberEnabled);
      setError(null);
    }, report);
  }, [rpc, report]);
  useEffect(refetch, [refetch]);
  useRealtime(PRESETS_CHANGED, refetch);
  const save = useCallback(
    async (sectionId: string, preset: SectionPreset | null) => {
      setPresets((current) => {
        const next = { ...current };
        if (preset === null) delete next[sectionId];
        else next[sectionId] = preset;
        return next;
      });
      try {
        const result = await rpc.call("presets_set", { sectionId, preset });
        setPresets(result.presets);
        setError(null);
      } catch (cause) {
        report(cause);
        refetch();
      }
    },
    [rpc, report, refetch],
  );
  const saveRemembered = useCallback(
    async (sectionId: string, next: Remembered | null) => {
      try {
        const result = await rpc.call("remembered_set", { sectionId, remembered: next });
        setRemembered(result.remembered);
      } catch (cause) {
        report(cause);
      }
    },
    [rpc, report],
  );
  return { sections, projects, presets, remembered, rememberEnabled, save, saveRemembered, error };
}

// --- Composer banner -------------------------------------------------------

interface Applied {
  token: string;
  sectionId: string;
  /** The rolled model choice, or null when the section has none. */
  choice: PresetChoice | null;
  /** Whether last-used settings were restored. */
  restored: boolean;
}

function readApplied(): Applied | null {
  try {
    const raw = sessionStorage.getItem(APPLIED_KEY);
    return raw === null ? null : (JSON.parse(raw) as Applied);
  } catch {
    return null;
  }
}

function toSelection(patch: SelectionPatch): ComposerSelection {
  return patch as ComposerSelection;
}

/** The parts of the composer's selection worth restoring next time. */
function toRemembered(selection: ComposerSelection): Remembered {
  const remembered: Remembered = {};
  if (selection.projectId !== undefined) remembered.projectId = selection.projectId;
  if (selection.environment !== undefined && selection.environment.type !== "reuse") {
    // A plain JSON object; bb validates it again when it is restored.
    remembered.environment = JSON.parse(JSON.stringify(selection.environment)) as Json;
  }
  if (selection.providerId !== undefined) remembered.providerId = selection.providerId;
  if (selection.model !== undefined) remembered.model = selection.model;
  if (selection.reasoningLevel !== undefined) remembered.reasoningLevel = selection.reasoningLevel;
  if (selection.serviceTier !== undefined) remembered.serviceTier = selection.serviceTier;
  if (selection.permissionMode !== undefined) remembered.permissionMode = selection.permissionMode;
  return remembered;
}

function SectionPresetBanner() {
  const composer = useComposer();
  const { sections, presets, remembered, rememberEnabled, saveRemembered } = usePresets();
  const [applied, setApplied] = useState<Applied | null>(readApplied);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const latest = useRef({ presets, remembered, rememberEnabled, selection: composer.selection });
  latest.current = { presets, remembered, rememberEnabled, selection: composer.selection };

  const apply = useCallback(
    (next: Applied, patch: SelectionPatch) => {
      sessionStorage.setItem(APPLIED_KEY, JSON.stringify(next));
      setApplied(next);
      const branch = worktreeBranch(patch.environment);
      composer
        .setSelection(toSelection(patch))
        .then(async () => {
          if (branch !== null && !(await selectWorktreeBranch(branch))) {
            console.warn(`[section-defaults] could not select worktree branch ${branch}`);
          }
        })
        .catch((cause: unknown) => {
          console.warn("[section-defaults] could not apply preset", cause);
        });
    },
    [composer],
  );

  // bb writes the placement as the compose route mounts, possibly after this
  // banner, so poll and act once the same (visit, section) pair has been seen
  // twice in a row. Each visit is applied once; coming back to it (or the
  // remount a project switch causes) keeps the earlier pick and any changes
  // made by hand.
  useEffect(() => {
    let previous: string | null = null;
    const check = () => {
      const current = readPlacementSectionId(window.history.state, sessionStorage);
      setSectionId(current);
      const { presets: config, remembered: memory, rememberEnabled: remember } = latest.current;
      const preset = current === null ? undefined : config?.[current];
      const last = current === null || !remember ? undefined : memory[current];
      if (current === null || config === null || (preset === undefined && last === undefined)) {
        previous = null;
        return;
      }
      const token = `${readNavigationKey(window.history.state) ?? ""}:${current}`;
      const stable = token === previous;
      previous = token;
      if (!stable || readApplied()?.token === token) return;
      const choice = preset === undefined ? null : pickChoice(preset.choices);
      const patch = buildSelection(last, choice);
      if (patch !== null) apply({ token, sectionId: current, choice, restored: last !== undefined }, patch);
    };
    check();
    const timer = window.setInterval(check, PLACEMENT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [apply]);

  // Record what each section's threads were actually started with.
  useEffect(
    () =>
      composer.onSubmitted(() => {
        const current = readPlacementSectionId(window.history.state, sessionStorage);
        const { rememberEnabled: remember, selection } = latest.current;
        if (current === null || !remember || selection === null) return;
        void saveRemembered(current, toRemembered(selection));
      }),
    [composer, saveRemembered],
  );

  if (applied === null || applied.sectionId !== sectionId) return null;
  const preset = presets?.[sectionId];
  const sectionName = sections.find((section) => section.id === sectionId)?.name ?? "Section";
  const live = preset?.choices.filter((choice) => choice.weight > 0) ?? [];
  const reroll = () => {
    const current = applied.choice;
    const others = live.filter(
      (choice) =>
        current === null ||
        choice.providerId !== current.providerId ||
        choice.model !== current.model ||
        choice.reasoningLevel !== current.reasoningLevel,
    );
    const choice = pickChoice(others.length > 0 ? others : live);
    const patch = buildSelection(undefined, choice);
    if (choice !== null && patch !== null) apply({ ...applied, choice }, patch);
  };
  const parts = [
    applied.restored ? (applied.choice === null ? "last-used settings" : "last-used workspace") : null,
    applied.choice === null || preset === undefined ? null : describeChoice(applied.choice, preset.choices),
  ].filter((part): part is string => part !== null);
  return (
    <div className="flex items-center gap-2 px-1 pb-1 text-xs text-muted-foreground">
      <Icon name="section-defaults/shuffle" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {sectionName}: {parts.join(" · ")}
      </span>
      {live.length > 1 ? (
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={reroll}>
          Re-roll
        </Button>
      ) : null}
    </div>
  );
}

// --- Settings page ---------------------------------------------------------

function newChoice(previous: PresetChoice | undefined): PresetChoice {
  if (previous !== undefined) return { ...previous, weight: 1 };
  return { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", weight: 1 };
}

function ChoiceRow({
  choice,
  choices,
  onChange,
  onRemove,
}: {
  choice: PresetChoice;
  choices: readonly PresetChoice[];
  onChange: (next: PresetChoice) => void;
  onRemove: () => void;
}) {
  const [weight, setWeight] = useState(String(choice.weight));
  useEffect(() => setWeight(String(choice.weight)), [choice.weight]);
  const commitWeight = () => {
    const parsed = Number(weight);
    if (Number.isFinite(parsed) && parsed >= 0) onChange({ ...choice, weight: parsed });
    else setWeight(String(choice.weight));
  };
  const odds = choiceOdds(choice, choices);
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <ProviderModelPicker
        value={{
          providerId: choice.providerId,
          model: choice.model,
          reasoningLevel: choice.reasoningLevel ?? "medium",
          ...(choice.serviceTier === undefined ? {} : { serviceTier: choice.serviceTier }),
        }}
        onChange={(value) => {
          const next: PresetChoice = {
            ...choice,
            providerId: value.providerId,
            model: value.model,
            reasoningLevel: value.reasoningLevel,
          };
          if (value.serviceTier === undefined) delete next.serviceTier;
          else next.serviceTier = value.serviceTier;
          onChange(next);
        }}
      />
      {choice.permissionMode === undefined ? (
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground"
          onClick={() => onChange({ ...choice, permissionMode: "auto" })}
        >
          Permission: bb default
        </Button>
      ) : (
        <span className="flex items-center">
          <PermissionModePicker
            providerId={choice.providerId}
            value={choice.permissionMode}
            onChange={(permissionMode) => onChange({ ...choice, permissionMode })}
            align="start"
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground"
            aria-label="Use bb's default permission mode"
            onClick={() => {
              const next = { ...choice };
              delete next.permissionMode;
              onChange(next);
            }}
          >
            <Icon name="X" className="size-3.5" />
          </Button>
        </span>
      )}
      <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>Weight</span>
        <Input
          className="h-7 w-16 text-xs"
          inputMode="decimal"
          value={weight}
          onChange={(event) => setWeight(event.target.value)}
          onBlur={commitWeight}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitWeight();
          }}
          aria-label="Weight"
        />
        <span className="w-9 text-right tabular-nums">{odds === null ? "" : `${odds}%`}</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          aria-label="Remove choice"
          onClick={onRemove}
        >
          <Icon name="Trash2" className="size-4" />
        </Button>
      </span>
    </li>
  );
}

/** A short label for a remembered `CreateThreadEnvironmentArgs`. */
function describeEnvironment(environment: Json | undefined): string | null {
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) return null;
  if (environment.type === "provider" && typeof environment.environmentProviderId === "string") {
    const branch = worktreeBranch(environment);
    return branch === null ? environment.environmentProviderId : `${environment.environmentProviderId} from ${branch}`;
  }
  const workspace = environment.workspace;
  if (environment.type === "host" && typeof workspace === "object" && workspace !== null && !Array.isArray(workspace)) {
    return typeof workspace.type === "string" ? workspace.type : "host";
  }
  return typeof environment.type === "string" ? environment.type : null;
}

function describeRemembered(remembered: Remembered, projects: readonly Section[]): string {
  const project = remembered.projectId === undefined
    ? undefined
    : (projects.find((candidate) => candidate.id === remembered.projectId)?.name ?? remembered.projectId);
  return [project, describeEnvironment(remembered.environment), remembered.model, remembered.reasoningLevel,
    remembered.permissionMode]
    .filter((part): part is string => part !== undefined && part !== null)
    .join(" · ");
}

function SectionEditor({
  section,
  preset,
  remembered,
  projects,
  onSave,
  onForget,
}: {
  section: Section;
  preset: SectionPreset | undefined;
  remembered: Remembered | undefined;
  projects: readonly Section[];
  onSave: (preset: SectionPreset | null) => void;
  onForget: () => void;
}) {
  const choices = preset?.choices ?? [];
  const update = (next: PresetChoice[]) => onSave(next.length === 0 ? null : { choices: next });
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{section.name}</span>
        <span className="text-xs text-muted-foreground">
          {choices.length === 0 ? (remembered === undefined ? "bb defaults" : "last used") : choices.length === 1 ? "fixed model" : "random model"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto text-xs"
          onClick={() => update([...choices, newChoice(choices[choices.length - 1])])}
        >
          <Icon name="Plus" className="size-3.5" />
          Add model
        </Button>
      </div>
      {remembered === undefined ? null : (
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">Last used: {describeRemembered(remembered, projects)}</span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onForget}>
            Forget
          </Button>
        </div>
      )}
      {choices.length === 0 ? null : (
        <ul className="mt-1 divide-y divide-border">
          {choices.map((choice, index) => (
            <ChoiceRow
              key={index}
              choice={choice}
              choices={choices}
              onChange={(next) => update(choices.map((existing, i) => (i === index ? next : existing)))}
              onRemove={() => update(choices.filter((_, i) => i !== index))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SettingsPage() {
  const { sections, projects, presets, remembered, save, saveRemembered, error } = usePresets();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        A sidebar section's <strong>+</strong> button starts the new thread with the project, workspace, and
        model last used from that section. Add models to a section to choose the model instead: with several,
        each new thread picks one at random by weight, and reasoning, tier, and permission go with the model.
      </p>
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {presets === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : sections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sections yet. Create one from the sidebar first.</p>
      ) : (
        sections.map((section) => (
          <SectionEditor
            key={section.id}
            section={section}
            preset={presets[section.id]}
            remembered={remembered[section.id]}
            projects={projects}
            onSave={(preset) => void save(section.id, preset)}
            onForget={() => void saveRemembered(section.id, null)}
          />
        ))
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "section-presets",
    title: "Section presets",
    component: SettingsPage,
  });
  app.composer.customize({
    id: "section-preset",
    scopes: ["new-thread"],
    banners: [{ id: "section-preset", chrome: "bare", component: SectionPresetBanner }],
  });
});
