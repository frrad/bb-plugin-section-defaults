import { test } from "node:test";
import assert from "node:assert/strict";
import { worktreeBranch } from "./worktree-branch.ts";

test("reads the base branch of a remembered new worktree", () => {
  assert.equal(
    worktreeBranch({
      type: "provider",
      environmentProviderId: "git-worktree",
      machine: { type: "existing", hostId: "host_1" },
      inputs: { branch: { kind: "named", name: "feature/x" } },
    }),
    "feature/x",
  );
});

test("returns null for the default branch, other providers, and existing worktrees", () => {
  assert.equal(
    worktreeBranch({ type: "provider", environmentProviderId: "git-worktree", inputs: { branch: { kind: "default" } } }),
    null,
  );
  assert.equal(
    worktreeBranch({ type: "provider", environmentProviderId: "project-checkout", inputs: { branch: { kind: "named", name: "x" } } }),
    null,
  );
  assert.equal(
    worktreeBranch({ type: "provider", environmentProviderId: "git-worktree", inputs: { kind: "existing", path: "/tmp/wt" } }),
    null,
  );
  assert.equal(worktreeBranch(undefined), null);
  assert.equal(worktreeBranch("git-worktree"), null);
});
