// Which sidebar section the new-thread screen will file its thread under.
//
// bb's public plugin API does not expose this (the new-thread composer scope
// carries only `projectId`), so it is read from two bb internals:
//
// - The section's `+` button calls `toCompose({ placement })`, which bb passes
//   as router state (`history.state.usr.placement`) until the compose route
//   consumes it.
// - The compose route then keeps the placement in sessionStorage under
//   `bb.root-compose.placement` as `{"sectionId": …, "pinned": …}`.
//
// Either can change in a bb update; when both are missing this reads null and
// the plugin does nothing.

export const PLACEMENT_KEY = "bb.root-compose.placement";

function sectionIdOf(placement: unknown): string | null {
  if (typeof placement !== "object" || placement === null || !("sectionId" in placement)) {
    return null;
  }
  const { sectionId } = placement;
  return typeof sectionId === "string" && sectionId.length > 0 ? sectionId : null;
}

export function readPlacementSectionId(
  historyState: unknown,
  storage: Pick<Storage, "getItem">,
): string | null {
  if (typeof historyState === "object" && historyState !== null && "usr" in historyState) {
    const { usr } = historyState;
    if (typeof usr === "object" && usr !== null && "placement" in usr) {
      return sectionIdOf(usr.placement);
    }
  }
  const stored = storage.getItem(PLACEMENT_KEY);
  if (stored === null) return null;
  try {
    return sectionIdOf(JSON.parse(stored));
  } catch {
    return null;
  }
}

/** Identifies one visit to the new-thread screen; bb's router gives every navigation a fresh key. */
export function readNavigationKey(historyState: unknown): string | null {
  if (typeof historyState !== "object" || historyState === null || !("key" in historyState)) {
    return null;
  }
  return typeof historyState.key === "string" ? historyState.key : null;
}
