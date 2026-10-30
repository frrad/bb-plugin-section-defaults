import type { SelectionPatch } from "./presets.ts";

/** One draw survives composer remounts; retries must never draw another model. */
export interface SelectionApplication {
  status: "pending" | "applied" | "error";
  /** While pending: what it is waiting for. After a failure: why, safe to show. */
  error: string | null;
  running: boolean;
  patch: SelectionPatch;
}

export function matchesModel(patch: SelectionPatch, actual: SelectionPatch): boolean {
  return (patch.providerId === undefined || patch.providerId === actual.providerId) &&
    (patch.model === undefined || patch.model === actual.model);
}

function describeModel(patch: SelectionPatch): string {
  return [patch.providerId, patch.model].filter((part) => part !== undefined).join("/") || "nothing";
}

class SelectTimeout extends Error {}

/**
 * Applies a drawn selection to the composer, failing loudly instead of waiting.
 *
 * bb's `setSelection` resolves only after the selected provider's model
 * catalog has loaded, so a model that is still missing once the provider
 * matches is not offered on that machine: that fails at once. A provider that
 * was ignored may still be starting up, so that alone is retried, but only
 * until `providerTimeoutMs`. A `setSelection` call that never settles fails
 * after `selectTimeoutMs`.
 */
export async function applySelection(
  application: SelectionApplication,
  options: {
    select: (patch: SelectionPatch) => Promise<SelectionPatch>;
    isCurrent: () => boolean;
    complete: () => Promise<void>;
    now?: () => number;
    wait?: () => Promise<void>;
    /** How long an ignored provider may take to appear. */
    providerTimeoutMs?: number;
    /** How long one `setSelection` call may take (a project switch included). */
    selectTimeoutMs?: number;
    /** Deprecated alias of providerTimeoutMs. */
    timeoutMs?: number;
  },
): Promise<void> {
  if (application.running || application.status === "applied") return;
  application.running = true;
  application.status = "pending";
  application.error = null;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (() => new Promise((resolve) => setTimeout(resolve, 500)));
  const deadline = now() + (options.providerTimeoutMs ?? options.timeoutMs ?? 10_000);
  const selectTimeoutMs = options.selectTimeoutMs ?? 25_000;
  const wanted = describeModel(application.patch);
  const fail = (message: string) => {
    application.status = "error";
    application.error = message;
    console.error(`[section-defaults] ${message}`);
  };
  const select = (patch: SelectionPatch): Promise<SelectionPatch> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SelectTimeout()), selectTimeoutMs);
    });
    return Promise.race([options.select(patch), timeout]).finally(() => clearTimeout(timer));
  };
  let patch = application.patch;
  try {
    while (options.isCurrent()) {
      let actual: SelectionPatch;
      try {
        actual = await select(patch);
      } catch (cause) {
        if (!options.isCurrent()) return;
        if (cause instanceof SelectTimeout) {
          fail(`bb did not finish switching to ${wanted} after ${Math.round(selectTimeoutMs / 1000)}s.`);
          return;
        }
        // setSelection's own rejections are permanent (bad value, composer gone).
        fail(cause instanceof Error ? cause.message : String(cause));
        return;
      }
      if (!options.isCurrent()) return;
      if (matchesModel(application.patch, actual)) {
        await options.complete();
        if (options.isCurrent()) {
          application.status = "applied";
          application.error = null;
        }
        return;
      }
      const providerMatches = application.patch.providerId === undefined ||
        application.patch.providerId === actual.providerId;
      if (providerMatches) {
        // The catalog has loaded and does not list the model.
        fail(`${wanted} is not available on this machine (bb picked ${describeModel(actual)} instead).`);
        return;
      }
      if (now() >= deadline) {
        fail(`Provider ${application.patch.providerId} is not available on this machine (bb picked ${describeModel(actual)} instead).`);
        return;
      }
      application.error = `Waiting for ${application.patch.providerId} to become available…`;
      // Project/environment switches need run only once; subsequent attempts
      // use the composer mounted by that switch and retry the model fields.
      const { projectId: _project, environment: _environment, ...model } = application.patch;
      patch = model;
      await wait();
    }
  } finally {
    application.running = false;
  }
}
