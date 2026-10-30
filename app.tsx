// bb-plugin-section-defaults — frontend entry.
//
// Two surfaces:
//
// - A banner on the new-thread composer. When the screen was opened from a
//   sidebar section's `+` button, it restores the project, workspace, and
//   model last used from that section, then, if the section has models (a
//   shared preset or a one-off list), picks one (weighted at random) for the
//   model. The banner says what it did and can re-roll. Sending from the
//   composer records the settings for next time. See placement.ts for how the
//   section is detected.
// - A settings page (Settings → Section Defaults) that edits the shared model
//   presets and each section's models with bb's own provider/model and
//   permission pickers, and shows what each section remembers.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { applySelection } from "./application.ts";
import type { SelectionApplication } from "./application.ts";
import { readNavigationKey, readPlacementSectionId } from "./placement.ts";
import { selectWorktreeBranch, worktreeBranch } from "./worktree-branch.ts";
import {
  PRESETS_CHANGED,
  buildSelection,
  choiceOdds,
  describeChoice,
  pickChoice,
  resolveSectionModels,
} from "./presets.ts";
import type {
  Json,
  ModelPreset,
  ModelPresetConfig,
  PresetChoice,
  Remembered,
  RememberedConfig,
  SectionModels,
  SectionModelsConfig,
  SelectionPatch,
} from "./presets.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

/** How often the banner rechecks which section the new-thread screen belongs to. */
const PLACEMENT_POLL_MS = 200;
/** Remembers which visit to the new-thread screen was already rolled, across reloads. */
const APPLIED_KEY = "section-defaults.applied.v2";
const PENDING_KEY = "section-defaults.pending.v2";

// The host remounts banners when a project switch completes. Keep the in-flight
// operation outside React so that remount cannot draw again or unlock early.
const applications = new Map<string, { next: Applied; job: SelectionApplication }>();
let activeComposer: ReturnType<typeof useComposer> | null = null;
let activeApplication: Promise<void> | null = null;

function currentVisit(): { sectionId: string; token: string } | null {
  const sectionId = readPlacementSectionId(window.history.state, sessionStorage);
  return sectionId === null ? null : {
    sectionId,
    token: `${readNavigationKey(window.history.state) ?? ""}:${sectionId}`,
  };
}

interface Section {
  id: string;
  name: string;
}

interface Config {
  sections: Section[];
  projects: Section[];
  modelPresets: ModelPresetConfig;
  sectionModels: SectionModelsConfig;
  defaultPresetId: string | null;
  remembered: RememberedConfig;
  rememberEnabled: boolean;
}

/** Everything the plugin stores, kept current by the server's realtime signal. */
function useConfig(): {
  config: Config | null;
  error: string | null;
  setSectionModels: (sectionId: string, models: SectionModels | null) => void;
  setDefaultPreset: (id: string | null) => void;
  saveModelPreset: (id: string | null, preset: ModelPreset) => void;
  deleteModelPreset: (id: string) => void;
  setRemembered: (sectionId: string, remembered: Remembered | null) => void;
  refetch: () => void;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("state_get").then((result) => {
      setConfig(result);
      setError(null);
    }, report);
  }, [rpc, report]);
  useEffect(refetch, [refetch]);
  useRealtime(PRESETS_CHANGED, refetch);
  // Writes update the local copy at once; the server's signal then refetches.
  const run = useCallback(
    (optimistic: (current: Config) => Config, call: () => Promise<unknown>) => {
      setConfig((current) => (current === null ? current : optimistic(current)));
      call().then(() => setError(null), (cause: unknown) => {
        report(cause);
        refetch();
      });
    },
    [report, refetch],
  );
  const setSectionModels = useCallback(
    (sectionId: string, models: SectionModels | null) =>
      run(
        (current) => {
          const sectionModels = { ...current.sectionModels };
          if (models === null) delete sectionModels[sectionId];
          else sectionModels[sectionId] = models;
          return { ...current, sectionModels };
        },
        () => rpc.call("section_models_set", { sectionId, models }),
      ),
    [rpc, run],
  );
  const setDefaultPreset = useCallback(
    (id: string | null) =>
      run(
        (current) => ({ ...current, defaultPresetId: id }),
        () => rpc.call("default_preset_set", { id }),
      ),
    [rpc, run],
  );
  const saveModelPreset = useCallback(
    (id: string | null, preset: ModelPreset) =>
      run(
        (current) => (id === null ? current : { ...current, modelPresets: { ...current.modelPresets, [id]: preset } }),
        () => rpc.call("model_preset_save", { id, preset }),
      ),
    [rpc, run],
  );
  const deleteModelPreset = useCallback(
    (id: string) =>
      run(
        (current) => {
          const modelPresets = { ...current.modelPresets };
          delete modelPresets[id];
          return {
            ...current,
            modelPresets,
            defaultPresetId: current.defaultPresetId === id ? null : current.defaultPresetId,
          };
        },
        () => rpc.call("model_preset_delete", { id }),
      ),
    [rpc, run],
  );
  const setRemembered = useCallback(
    (sectionId: string, remembered: Remembered | null) =>
      run(
        (current) => {
          const all = { ...current.remembered };
          if (remembered === null) delete all[sectionId];
          else all[sectionId] = remembered;
          return { ...current, remembered: all };
        },
        () => rpc.call("remembered_set", { sectionId, remembered }),
      ),
    [rpc, run],
  );
  return { config, error, setSectionModels, setDefaultPreset, saveModelPreset, deleteModelPreset, setRemembered, refetch };
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
  const { config, error: configError, setRemembered, refetch } = useConfig();
  const [applied, setApplied] = useState<Applied | null>(readApplied);
  const [sectionId, setSectionId] = useState<string | null>(() => currentVisit()?.sectionId ?? null);
  const [progress, setProgress] = useState<string | null>(null);
  const [applicationError, setApplicationError] = useState<string | null>(null);
  const latest = useRef({ config, selection: composer.selection });
  latest.current = { config, selection: composer.selection };

  const apply = useCallback((next: Applied, patch: SelectionPatch) => {
    const job: SelectionApplication = { patch, status: "pending", running: false, error: null };
    applications.set(next.token, { next, job });
    if (applications.size > 50) {
      for (const [token, entry] of applications) {
        if (token !== next.token && !entry.job.running) applications.delete(token);
        if (applications.size <= 50) break;
      }
    }
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ next, patch }));
    setProgress("Applying section defaults…");
    setApplicationError(null);
  }, []);

  // Lock before paint, including while config loads. The SDK's input lock only
  // locks editing, so also guard the host's send button and keyboard submission.
  // These data attributes belong to bb's composer, like placement.ts's route
  // keys; keep this fallback scoped to the mounted new-thread banner.
  useLayoutEffect(() => {
    activeComposer = composer;
    let blocked = false;
    let alive = true;
    const guard = (event: Event) => {
      check();
      queueMicrotask(check); // router state is written by the click handler
      if (!blocked || !(event.target instanceof Element)) return;
      const target = event.target;
      const send = target.closest("[data-promptbox-submit-action], [data-promptbox-submit-group]");
      const enter = event instanceof KeyboardEvent && event.key === "Enter" &&
        !event.shiftKey && target.closest("[data-promptbox]");
      if (send || enter || (event.type === "submit" && target.querySelector("[data-promptbox]"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const check = () => {
      if (!alive) return;
      const visit = currentVisit();
      setSectionId(visit?.sectionId ?? null);
      if (visit === null) {
        blocked = false;
        composer.setInputLock(false);
        setProgress(null);
        setApplicationError(null);
        return;
      }
      const state = latest.current.config;
      let entry = applications.get(visit.token);
      if (entry === undefined && readApplied()?.token !== visit.token && state !== null) {
        const models = resolveSectionModels(
          state.sectionModels[visit.sectionId], state.modelPresets, state.defaultPresetId,
        );
        const last = state.rememberEnabled ? state.remembered[visit.sectionId] : undefined;
        let saved: { next: Applied; patch: SelectionPatch } | null = null;
        try { saved = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null"); } catch { /* draw below */ }
        if (saved?.next.token === visit.token) {
          apply(saved.next, saved.patch);
        } else {
          const choice = models === null ? null : pickChoice(models.choices);
          const patch = buildSelection(last, choice);
          if (patch !== null) apply({ token: visit.token, sectionId: visit.sectionId, choice, restored: last !== undefined }, patch);
        }
        entry = applications.get(visit.token);
      }
      blocked = (state === null && entry === undefined && readApplied()?.token !== visit.token) ||
        (entry !== undefined && entry.job.status !== "applied");
      composer.setInputLock(blocked);
      setProgress(
        state === null && blocked ? "Loading section defaults…"
          : entry?.job.status === "pending" ? `Applying section defaults…${entry.job.error === null ? "" : ` ${entry.job.error}`}`
          : null,
      );
      setApplicationError(entry?.job.status === "error" ? entry.job.error : null);
      if (entry?.job.status === "applied") setApplied(entry.next);
      if (entry !== undefined && entry.job.status === "pending" && !entry.job.running && activeApplication === null) {
        const { next, job } = entry;
        activeApplication = applySelection(job, {
          isCurrent: () => currentVisit()?.token === next.token,
          select: async (patch) => {
            if (activeComposer === null) throw new Error("Waiting for the composer to finish loading.");
            return await activeComposer.setSelection(toSelection(patch)) as SelectionPatch;
          },
          complete: async () => {
            const branch = worktreeBranch(job.patch.environment);
            if (branch !== null && !(await selectWorktreeBranch(branch))) {
              console.warn(`[section-defaults] could not select worktree branch ${branch}`);
            }
            if (currentVisit()?.token !== next.token) return;
            sessionStorage.setItem(APPLIED_KEY, JSON.stringify(next));
            sessionStorage.removeItem(PENDING_KEY);
          },
        }).finally(() => { activeApplication = null; });
      }
    };
    document.addEventListener("click", guard, true);
    document.addEventListener("keydown", guard, true);
    document.addEventListener("submit", guard, true);
    check();
    const timer = window.setInterval(check, PLACEMENT_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("click", guard, true);
      document.removeEventListener("keydown", guard, true);
      document.removeEventListener("submit", guard, true);
      composer.setInputLock(false);
      if (activeComposer === composer) activeComposer = null;
    };
  }, [composer, config, apply]);

  // A cold-start RPC failure must not strand the composer until a realtime edit.
  useEffect(() => {
    if (config !== null || configError === null) return;
    const timer = window.setInterval(refetch, 1000);
    return () => window.clearInterval(timer);
  }, [config, configError, refetch]);

  // Record what each section's threads were actually started with.
  useEffect(
    () =>
      composer.onSubmitted(() => {
        const current = readPlacementSectionId(window.history.state, sessionStorage);
        const { config: state, selection } = latest.current;
        if (current === null || state === null || !state.rememberEnabled || selection === null) return;
        setRemembered(current, toRemembered(selection));
      }),
    [composer, setRemembered],
  );

  if (sectionId !== null && (progress !== null || applicationError !== null || configError !== null)) {
    const error = applicationError ?? configError;
    const visit = currentVisit();
    const entry = visit === null ? undefined : applications.get(visit.token);
    const failedChoice = applicationError === null ? null : entry?.next.choice ?? null;
    const sectionChoices = config === null ? [] :
      resolveSectionModels(config.sectionModels[sectionId], config.modelPresets, config.defaultPresetId)
        ?.choices.filter((choice) => choice.weight > 0) ?? [];
    const alternatives = failedChoice === null ? [] : sectionChoices.filter(
      (choice) => choice.providerId !== failedChoice.providerId || choice.model !== failedChoice.model,
    );
    const retry = () => {
      if (entry !== undefined) { entry.job.status = "pending"; entry.job.error = null; }
      refetch();
      setApplicationError(null);
      setProgress("Applying section defaults…");
    };
    const reroll = () => {
      if (entry === undefined || config === null) return;
      const choice = pickChoice(alternatives);
      const last = config.rememberEnabled ? config.remembered[entry.next.sectionId] : undefined;
      const patch = buildSelection(last, choice);
      if (choice !== null && patch !== null) apply({ ...entry.next, choice }, patch);
    };
    const proceed = () => {
      if (entry === undefined) return;
      entry.job.status = "applied";
      entry.job.error = null;
      const next = { ...entry.next, choice: null };
      sessionStorage.setItem(APPLIED_KEY, JSON.stringify(next));
      sessionStorage.removeItem(PENDING_KEY);
      composer.setInputLock(false);
      setApplied(next);
      setApplicationError(null);
      setProgress(null);
    };
    return (
      <div
        className={`flex flex-wrap items-center gap-2 px-1 pb-1 text-xs ${error === null ? "text-muted-foreground" : "text-destructive"}`}
        role={error === null ? "status" : "alert"}
      >
        <span>{error === null ? progress : `Section defaults failed: ${error}`}</span>
        {error === null ? null : (
          <>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={retry}>Retry</Button>
            {alternatives.length > 0 ? (
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={reroll}>Re-roll</Button>
            ) : null}
            {applicationError !== null && entry !== undefined ? (
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={proceed}>Use current model</Button>
            ) : null}
          </>
        )}
      </div>
    );
  }
  if (applied === null || applied.sectionId !== sectionId || config === null) return null;
  const models = resolveSectionModels(config.sectionModels[sectionId], config.modelPresets, config.defaultPresetId);
  const sectionName = config.sections.find((section) => section.id === sectionId)?.name ?? "Section";
  const live = models?.choices.filter((choice) => choice.weight > 0) ?? [];
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
    models?.presetName ?? null,
    applied.choice === null || models === null ? null : describeChoice(applied.choice, models.choices),
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

/** Edits a weighted list of models; shared by presets and one-off section lists. */
function ChoicesEditor({
  choices,
  onChange,
}: {
  choices: readonly PresetChoice[];
  onChange: (next: PresetChoice[]) => void;
}) {
  return (
    <>
      {choices.length === 0 ? null : (
        <ul className="mt-1 divide-y divide-border">
          {choices.map((choice, index) => (
            <ChoiceRow
              key={index}
              choice={choice}
              choices={choices}
              onChange={(next) => onChange(choices.map((existing, i) => (i === index ? next : existing)))}
              onRemove={() => onChange(choices.filter((_, i) => i !== index))}
            />
          ))}
        </ul>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="mt-1 text-xs"
        onClick={() => onChange([...choices, newChoice(choices[choices.length - 1])])}
      >
        <Icon name="Plus" className="size-3.5" />
        Add model
      </Button>
    </>
  );
}

function PresetEditor({
  preset,
  usedBy,
  onSave,
  onDelete,
}: {
  preset: ModelPreset;
  usedBy: readonly string[];
  onSave: (preset: ModelPreset) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(preset.name);
  useEffect(() => setName(preset.name), [preset.name]);
  const commitName = () => {
    const next = name.trim();
    if (next === "" || next === preset.name) setName(preset.name);
    else onSave({ ...preset, name: next });
  };
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2">
        <Input
          className="h-7 w-48 text-sm font-medium"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitName();
          }}
          aria-label="Preset name"
        />
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {usedBy.length === 0 ? "not used yet" : `used by ${usedBy.join(", ")}`}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-7 text-muted-foreground hover:text-foreground"
          aria-label={`Delete preset ${preset.name}; sections using it keep a copy of its models`}
          onClick={onDelete}
        >
          <Icon name="Trash2" className="size-4" />
        </Button>
      </div>
      <ChoicesEditor choices={preset.choices} onChange={(choices) => onSave({ ...preset, choices })} />
    </div>
  );
}

const NO_MODELS = "";
const ONE_OFF = "__one-off__";

function SectionEditor({
  section,
  models,
  presets,
  defaultPresetId,
  remembered,
  projects,
  onChange,
  onForget,
}: {
  section: Section;
  models: SectionModels | undefined;
  presets: ModelPresetConfig;
  defaultPresetId: string | null;
  remembered: Remembered | undefined;
  projects: readonly Section[];
  onChange: (models: SectionModels | null) => void;
  onForget: () => void;
}) {
  const mode = models === undefined ? NO_MODELS : "presetId" in models ? models.presetId : ONE_OFF;
  const resolved = resolveSectionModels(models, presets);
  const switchTo = (next: string) => {
    if (next === NO_MODELS) onChange(null);
    // Start a one-off list from whatever the section rolls from today.
    else if (next === ONE_OFF) onChange({ choices: resolved?.choices.map((choice) => ({ ...choice })) ?? [newChoice(undefined)] });
    else onChange({ presetId: next });
  };
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{section.name}</span>
        <select
          className="ml-auto h-7 rounded-md border border-border bg-background px-2 text-xs"
          value={mode}
          onChange={(event) => switchTo(event.target.value)}
          aria-label={`Models for ${section.name}`}
        >
          <option value={NO_MODELS}>
            {defaultPresetId === null
              ? "Model: last used"
              : `Model: default (${presets[defaultPresetId]?.name ?? "missing preset"})`}
          </option>
          {Object.entries(presets).map(([id, preset]) => (
            <option key={id} value={id}>
              Preset: {preset.name}
            </option>
          ))}
          <option value={ONE_OFF}>One-off models</option>
        </select>
      </div>
      {remembered === undefined ? null : (
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">Last used: {describeRemembered(remembered, projects)}</span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onForget}>
            Forget
          </Button>
        </div>
      )}
      {models !== undefined && "choices" in models ? (
        <ChoicesEditor choices={models.choices} onChange={(choices) => onChange({ choices })} />
      ) : resolved === null ? null : (
        <p className="mt-1 text-xs text-muted-foreground">
          {resolved.choices.map((choice) => describeChoice(choice, resolved.choices)).join("  ·  ")}
        </p>
      )}
    </div>
  );
}

function SettingsPage() {
  const { config, error, setSectionModels, setDefaultPreset, saveModelPreset, deleteModelPreset, setRemembered } =
    useConfig();
  const usedBy = (presetId: string): string[] =>
    config?.sections
      .filter((section) => {
        const models = config.sectionModels[section.id];
        return models !== undefined && "presetId" in models && models.presetId === presetId;
      })
      .map((section) => section.name) ?? [];
  const addPreset = () => {
    if (config === null) return;
    const taken = new Set(Object.values(config.modelPresets).map((preset) => preset.name.toLowerCase()));
    let name = "New preset";
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `New preset ${n}`;
    saveModelPreset(null, { name, choices: [newChoice(undefined)] });
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        A sidebar section's <strong>+</strong> button starts the new thread with the project, workspace, and
        model last used from that section. To choose the model instead, set a default preset for all sections or
        give one section a preset (shared, so editing it updates every section using it) or one-off models. With
        several models, each new thread picks one at random by weight; reasoning, tier, and permission go with
        the model.
      </p>
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {config === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="rounded-lg border border-border bg-card px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Default preset</span>
              <select
                className="ml-auto h-7 rounded-md border border-border bg-background px-2 text-xs"
                value={config.defaultPresetId ?? NO_MODELS}
                onChange={(event) => setDefaultPreset(event.target.value || null)}
                aria-label="Default model preset"
              >
                <option value={NO_MODELS}>None</option>
                {Object.entries(config.modelPresets).map(([id, preset]) => (
                  <option key={id} value={id}>{preset.name}</option>
                ))}
              </select>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Used by sections without their own models, instead of their last-used model.
            </p>
          </div>
          <div className="flex items-center gap-2 pt-2">
            <h3 className="text-sm font-medium">Model presets</h3>
            <Button variant="ghost" size="sm" className="ml-auto text-xs" onClick={addPreset}>
              <Icon name="Plus" className="size-3.5" />
              New preset
            </Button>
          </div>
          {Object.keys(config.modelPresets).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No presets yet. Create one, e.g. "Smart" or "Fast", then pick it for sections below.
            </p>
          ) : (
            Object.entries(config.modelPresets).map(([id, preset]) => (
              <PresetEditor
                key={id}
                preset={preset}
                usedBy={usedBy(id)}
                onSave={(next) => saveModelPreset(id, next)}
                onDelete={() => deleteModelPreset(id)}
              />
            ))
          )}
          <h3 className="pt-2 text-sm font-medium">Sections</h3>
          {config.sections.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sections yet. Create one from the sidebar first.</p>
          ) : (
            config.sections.map((section) => (
              <SectionEditor
                key={section.id}
                section={section}
                models={config.sectionModels[section.id]}
                presets={config.modelPresets}
                defaultPresetId={config.defaultPresetId}
                remembered={config.remembered[section.id]}
                projects={config.projects}
                onChange={(models) => setSectionModels(section.id, models)}
                onForget={() => setRemembered(section.id, null)}
              />
            ))
          )}
        </>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "section-presets",
    title: "Section defaults",
    component: SettingsPage,
  });
  app.composer.customize({
    id: "section-preset",
    scopes: ["new-thread"],
    banners: [{ id: "section-preset", chrome: "bare", component: SectionPresetBanner }],
  });
});
