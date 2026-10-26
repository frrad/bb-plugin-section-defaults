import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  window.history.replaceState({ key: crypto.randomUUID(), usr: { placement: { sectionId: "section" } } }, "");
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const config = {
  sections: [{ id: "section", name: "Test" }], projects: [], remembered: {}, rememberEnabled: true,
  modelPresets: {}, sectionModels: { section: { choices: [{ providerId: "claude-code", model: "opus", weight: 1 }] } },
};
async function mount(state_get: () => unknown) {
  const app = await loadPluginApp(() => import("./app.tsx"));
  return renderSlot(app.composerCustomizations[0]!.banners![0]!, {}, {
    rpc: { state_get },
    composer: { scope: { kind: "new-thread", projectId: null }, selection: { providerId: "codex", model: "default" } },
  });
}

test("cold startup locks input and blocks sends until config and the model are applied", async () => {
  let resolve!: (state: typeof config) => void;
  const slot = await mount(() => new Promise((done) => { resolve = done; }));
  expect(slot.inspection.composer.inputLocked).toBe(true);
  expect(slot.getByRole("status").textContent).toContain("Loading");
  const button = document.createElement("button");
  button.setAttribute("data-promptbox-submit-action", "");
  document.body.append(button);
  const sent = vi.fn(); button.addEventListener("click", sent);
  fireEvent.click(button);
  expect(sent).not.toHaveBeenCalled();
  const editor = document.createElement("div"); editor.setAttribute("data-promptbox", ""); document.body.append(editor);
  const entered = vi.fn(); editor.addEventListener("keydown", entered);
  fireEvent.keyDown(editor, { key: "Enter" });
  expect(entered).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("section-defaults.applied.v2")).toBeNull();
  await act(async () => { resolve(config); });
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(slot.inspection.composer.selection?.providerId).toBe("claude-code");
  expect(slot.inspection.composer.inputLocked).toBe(false);
  fireEvent.click(button); expect(sent).toHaveBeenCalledOnce();
  slot.lifecycle.unmount(); button.remove(); editor.remove();
  expect(slot.inspection.composer.inputLocked).toBe(false);
});

test("startup RPC errors retry automatically and then unlock", async () => {
  let calls = 0;
  const slot = await mount(() => { if (++calls < 3) throw new Error("starting"); return config; });
  await act(async () => {});
  expect(slot.inspection.composer.inputLocked).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(2400); });
  expect(calls).toBe(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(slot.inspection.composer.inputLocked).toBe(false);
});

test("a section navigation in the same composer is guarded before the next poll", async () => {
  window.history.replaceState({ key: "initial", usr: { placement: null } }, "");
  const slot = await mount(() => config);
  await act(async () => {});
  expect(slot.inspection.composer.inputLocked).toBe(false);
  window.history.replaceState({ key: "new-visit", usr: { placement: { sectionId: "section" } } }, "");
  const button = document.createElement("button"); button.setAttribute("data-promptbox-submit-action", ""); document.body.append(button);
  const sent = vi.fn(); button.addEventListener("click", sent);
  fireEvent.click(button);
  expect(sent).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(slot.inspection.composer.selection?.model).toBe("opus");
  expect(slot.inspection.composer.inputLocked).toBe(false);
  button.remove();
});
