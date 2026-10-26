// Restoring a worktree's base branch.
//
// `composer.setSelection` switches the composer to the Worktree environment
// but does not apply provider inputs, so the base branch stays "Default
// branch". The branch is a choice in the Worktree plugin's own control, so
// this opens that control and clicks the remembered branch, as a person
// would. It depends on that control's markup (a `Worktree` combobox whose
// menu items carry the branch name as their `title`); if a bb update changes
// it, the branch is left at the default and nothing else is affected.

const WORKTREE_PROVIDER_ID = "git-worktree";
const BUTTON_SELECTOR = 'button[aria-label="Worktree"][role="combobox"]';
const WAIT_MS = 4000;
const STEP_MS = 100;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The base branch of a remembered new-worktree environment, or null. */
export function worktreeBranch(environment: unknown): string | null {
  if (!isObject(environment) || environment.environmentProviderId !== WORKTREE_PROVIDER_ID) return null;
  const inputs = environment.inputs;
  if (!isObject(inputs) || !isObject(inputs.branch)) return null;
  const { kind, name } = inputs.branch;
  return kind === "named" && typeof name === "string" && name.length > 0 ? name : null;
}

async function waitFor<T>(find: () => T | null): Promise<T | null> {
  for (let waited = 0; waited <= WAIT_MS; waited += STEP_MS) {
    const found = find();
    if (found !== null) return found;
    await new Promise((resolve) => setTimeout(resolve, STEP_MS));
  }
  return null;
}

/** Picks `branch` in the Worktree control. Resolves whether it was found. */
export async function selectWorktreeBranch(branch: string): Promise<boolean> {
  const button = await waitFor(() => document.querySelector<HTMLButtonElement>(BUTTON_SELECTOR));
  if (button === null) return false;
  button.click();
  const item = await waitFor(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>("[title]")).find(
        (element) => element.getAttribute("title") === branch && !button.contains(element),
      ) ?? null,
  );
  if (item === null) {
    // Close the menu again rather than leave it open on a branch that is gone.
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  }
  item.click();
  return true;
}
