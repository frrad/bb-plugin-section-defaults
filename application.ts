import type { SelectionPatch } from "./presets.ts";

/** One draw survives composer remounts; retries must never draw another model. */
export interface SelectionApplication {
  status: "pending" | "applied" | "error";
  error: string | null;
  running: boolean;
  patch: SelectionPatch;
}

export function matchesModel(patch: SelectionPatch, actual: SelectionPatch): boolean {
  return (patch.providerId === undefined || patch.providerId === actual.providerId) &&
    (patch.model === undefined || patch.model === actual.model);
}

/** The host may silently ignore a provider while discovery is still loading. */
export async function applySelection(
  application: SelectionApplication,
  options: {
    select: (patch: SelectionPatch) => Promise<SelectionPatch>;
    isCurrent: () => boolean;
    complete: () => Promise<void>;
    now?: () => number;
    wait?: () => Promise<void>;
    timeoutMs?: number;
  },
): Promise<void> {
  if (application.running || application.status === "applied") return;
  application.running = true;
  application.status = "pending";
  application.error = null;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (() => new Promise((resolve) => setTimeout(resolve, 500)));
  const deadline = now() + (options.timeoutMs ?? 30_000);
  let patch = application.patch;
  try {
    while (options.isCurrent()) {
      try {
        const actual = await options.select(patch);
        if (!options.isCurrent()) return;
        if (matchesModel(application.patch, actual)) {
          await options.complete();
          if (options.isCurrent()) application.status = "applied";
          return;
        }
        application.error = "Waiting for the selected provider and model to become available.";
        // Project/environment switches need run only once; subsequent attempts
        // use the composer mounted by that switch and retry the model fields.
        const { projectId: _project, environment: _environment, ...model } = application.patch;
        patch = model;
      } catch (cause) {
        if (!options.isCurrent()) return;
        application.error = cause instanceof Error ? cause.message : String(cause);
      }
      if (now() >= deadline) {
        application.status = "error";
        return;
      }
      await wait();
    }
  } finally {
    application.running = false;
  }
}
