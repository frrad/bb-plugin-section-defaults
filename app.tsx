// bb-plugin-section-defaults — frontend entry.
//
// Two surfaces:
//
// - A banner on the new-thread composer. When the screen was opened from a
//   sidebar section's `+` button and that section has a preset, it picks one
//   of the preset's choices (weighted at random) and sets the composer's
//   provider, model, reasoning, tier, and permission pickers to it. The banner
//   says what it picked and can re-roll. See placement.ts for how the section
//   is detected.
// - A settings page (Settings → Section Defaults) that edits each section's
//   choices with bb's own provider/model and permission pickers.
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
import { PRESETS_CHANGED, choiceOdds, describeChoice, pickChoice } from "./presets.ts";
import type { PresetChoice, PresetConfig, SectionPreset } from "./presets.ts";
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
  presets: PresetConfig | null;
  save: (sectionId: string, preset: SectionPreset | null) => Promise<void>;
  error: string | null;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [sections, setSections] = useState<Section[]>([]);
  const [presets, setPresets] = useState<PresetConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("presets_get").then((result) => {
      setSections(result.sections);
      setPresets(result.presets);
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
  return { sections, presets, save, error };
}

// --- Composer banner -------------------------------------------------------

interface Applied {
  token: string;
  sectionId: string;
  choice: PresetChoice;
}

function readApplied(): Applied | null {
  try {
    const raw = sessionStorage.getItem(APPLIED_KEY);
    return raw === null ? null : (JSON.parse(raw) as Applied);
  } catch {
    return null;
  }
}

function toSelection(choice: PresetChoice): ComposerSelection {
  const selection: ComposerSelection = { providerId: choice.providerId, model: choice.model };
  if (choice.reasoningLevel !== undefined) selection.reasoningLevel = choice.reasoningLevel;
  if (choice.serviceTier !== undefined) selection.serviceTier = choice.serviceTier;
  if (choice.permissionMode !== undefined) selection.permissionMode = choice.permissionMode;
  return selection;
}

function SectionPresetBanner() {
  const composer = useComposer();
  const { sections, presets } = usePresets();
  const [applied, setApplied] = useState<Applied | null>(readApplied);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const presetsRef = useRef(presets);
  presetsRef.current = presets;

  const apply = useCallback(
    (token: string, targetSectionId: string, choice: PresetChoice) => {
      const next: Applied = { token, sectionId: targetSectionId, choice };
      sessionStorage.setItem(APPLIED_KEY, JSON.stringify(next));
      setApplied(next);
      composer.setSelection(toSelection(choice)).catch((cause: unknown) => {
        console.warn("[section-defaults] could not apply preset", cause);
      });
    },
    [composer],
  );

  // bb writes the placement as the compose route mounts, possibly after this
  // banner, so poll and act once the same (visit, section) pair has been seen
  // twice in a row. Each visit is rolled once; coming back to it keeps the
  // earlier pick and any changes made by hand.
  useEffect(() => {
    let previous: string | null = null;
    const check = () => {
      const current = readPlacementSectionId(window.history.state, sessionStorage);
      setSectionId(current);
      const preset = current === null ? undefined : presetsRef.current?.[current];
      if (current === null || preset === undefined) {
        previous = null;
        return;
      }
      const token = `${readNavigationKey(window.history.state) ?? ""}:${current}`;
      const stable = token === previous;
      previous = token;
      if (!stable || readApplied()?.token === token) return;
      const choice = pickChoice(preset.choices);
      if (choice !== null) apply(token, current, choice);
    };
    check();
    const timer = window.setInterval(check, PLACEMENT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [apply]);

  const preset = sectionId === null ? undefined : presets?.[sectionId];
  if (applied === null || preset === undefined || applied.sectionId !== sectionId) return null;
  const sectionName = sections.find((section) => section.id === sectionId)?.name ?? "Section";
  const live = preset.choices.filter((choice) => choice.weight > 0);
  const reroll = () => {
    const others = live.filter(
      (choice) => choice.providerId !== applied.choice.providerId || choice.model !== applied.choice.model ||
        choice.reasoningLevel !== applied.choice.reasoningLevel,
    );
    const choice = pickChoice(others.length > 0 ? others : live);
    if (choice !== null) apply(applied.token, applied.sectionId, choice);
  };
  return (
    <div className="flex items-center gap-2 px-1 pb-1 text-xs text-muted-foreground">
      <Icon name="section-defaults/shuffle" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {sectionName}: {describeChoice(applied.choice, preset.choices)}
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

function SectionEditor({
  section,
  preset,
  onSave,
}: {
  section: Section;
  preset: SectionPreset | undefined;
  onSave: (preset: SectionPreset | null) => void;
}) {
  const choices = preset?.choices ?? [];
  const update = (next: PresetChoice[]) => onSave(next.length === 0 ? null : { choices: next });
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{section.name}</span>
        <span className="text-xs text-muted-foreground">
          {choices.length === 0 ? "bb defaults" : choices.length === 1 ? "fixed" : "random"}
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
  const { sections, presets, save, error } = usePresets();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Choose the models a sidebar section's <strong>+</strong> button starts threads with. With several
        models, each new thread picks one at random by weight; reasoning, tier, and permission go with the
        model.
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
            onSave={(preset) => void save(section.id, preset)}
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
