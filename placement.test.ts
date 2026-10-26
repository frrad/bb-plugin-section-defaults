import { test } from "node:test";
import assert from "node:assert/strict";
import { PLACEMENT_KEY, readPlacementSectionId } from "./placement.ts";

function storageWith(value: string | null): Pick<Storage, "getItem"> {
  return { getItem: (key: string) => (key === PLACEMENT_KEY ? value : null) };
}

test("reads the section from router state before it is consumed", () => {
  const historyState = { usr: { placement: { sectionId: "sec_new", pinned: false } } };
  const storage = storageWith('{"sectionId":"sec_old","pinned":false}');
  assert.equal(readPlacementSectionId(historyState, storage), "sec_new");
});

test("falls back to the stored placement once router state is cleared", () => {
  const historyState = { usr: null, key: "abc", idx: 1 };
  const storage = storageWith('{"sectionId":"sec_y3uzuhg6m7","pinned":false}');
  assert.equal(readPlacementSectionId(historyState, storage), "sec_y3uzuhg6m7");
});

test("returns null outside a section", () => {
  assert.equal(readPlacementSectionId(null, storageWith('{"sectionId":null,"pinned":true}')), null);
  assert.equal(readPlacementSectionId(null, storageWith(null)), null);
});

test("ignores malformed stored values", () => {
  assert.equal(readPlacementSectionId(null, storageWith("not json")), null);
  assert.equal(readPlacementSectionId(null, storageWith('{"sectionId":42}')), null);
  assert.equal(readPlacementSectionId({ usr: { placement: "sec_x" } }, storageWith(null)), null);
});
