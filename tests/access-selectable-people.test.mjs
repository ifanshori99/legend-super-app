import assert from "node:assert/strict";
import { test } from "node:test";
import * as lib from "../apps/web/src/features/ws01-access/lib.ts";

// legend E1 (CTO 2026-11-11): a former staff member (status "inactive") stays
// in the directory so names resolve, but is never offered in a grant or
// approver picker.

const person = (id, status) => ({
  id,
  name: `Person ${id}`,
  kind: "staff",
  status,
});

test("E1 · selectablePeople offers only active people", () => {
  const people = [
    person("a", "active"),
    person("b", "inactive"),
    person("c", "active"),
  ];
  assert.deepEqual(
    lib.selectablePeople(people).map((row) => row.id),
    ["a", "c"],
  );
});

test("E1 · selectablePeople does not mutate the directory and handles empty", () => {
  const people = [person("a", "inactive")];
  assert.deepEqual(lib.selectablePeople(people), []);
  assert.equal(people.length, 1);
  assert.deepEqual(lib.selectablePeople([]), []);
});
