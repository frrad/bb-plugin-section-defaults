import assert from "node:assert/strict";
import { test } from "node:test";
import { applySelection } from "./application.ts";
import type { SelectionApplication } from "./application.ts";

const patch = { providerId: "claude-code", model: "opus", projectId: "project" };
const make = (): SelectionApplication => ({ patch, status: "pending", running: false, error: null });

test("a provider ignored during startup retries the same draw and only then completes", async () => {
  const job = make();
  const calls: unknown[] = [];
  let completed = false;
  await applySelection(job, {
    isCurrent: () => true,
    select: async (selection) => {
      calls.push(selection);
      assert.equal(job.status, "pending");
      assert.equal(completed, false);
      return calls.length < 3 ? { providerId: "codex", model: "default" } : patch;
    },
    wait: async () => {},
    complete: async () => { completed = true; },
  });
  assert.deepEqual(calls, [patch, { providerId: "claude-code", model: "opus" }, { providerId: "claude-code", model: "opus" }]);
  assert.equal(completed, true);
  assert.equal(job.status, "applied");
});

test("composer remounts cannot start a second application while the first is pending", async () => {
  const job = make();
  let resolve!: (value: typeof patch) => void;
  let calls = 0;
  const options = {
    isCurrent: () => true,
    select: () => { calls++; return new Promise<typeof patch>((done) => { resolve = done; }); },
    complete: async () => {},
  };
  const pending = applySelection(job, options);
  await applySelection(job, options);
  assert.equal(calls, 1);
  assert.equal(job.status, "pending");
  resolve(patch);
  await pending;
  assert.equal(job.status, "applied");
});

test("errors stay unapplied and a manual retry can recover the original draw", async () => {
  const job = make();
  const options = { isCurrent: () => true, complete: async () => {}, timeoutMs: 0 };
  await applySelection(job, { ...options, select: async () => { throw new Error("offline"); } });
  assert.equal(job.status, "error");
  assert.equal(job.error, "offline");
  assert.equal(job.running, false);
  await applySelection(job, { ...options, select: async () => patch });
  assert.equal(job.status, "applied");
});

test("navigation during an async switch never commits the previous visit", async () => {
  const job = make();
  let current = true;
  let completed = false;
  await applySelection(job, {
    isCurrent: () => current,
    select: async () => { current = false; return patch; },
    complete: async () => { completed = true; },
  });
  assert.equal(completed, false);
  assert.equal(job.status, "pending");
  assert.equal(job.running, false);
});

test("host reconciliation of reasoning and permissions does not trigger endless retries", async () => {
  const job = make();
  await applySelection(job, {
    isCurrent: () => true,
    select: async () => ({ ...patch, reasoningLevel: "medium", permissionMode: "auto" }),
    complete: async () => {},
  });
  assert.equal(job.status, "applied");
});
