import assert from "node:assert/strict";
import { test } from "node:test";
import { extendCurrentSession } from "../packages/shared/src/identity/index.ts";

test("AUTH-05: explicit session activity has a bodyless POST contract", () => {
  assert.equal(extendCurrentSession.method, "POST");
  assert.equal(
    extendCurrentSession.path,
    "/api/auth/sessions/current/activity",
  );
  assert.equal(extendCurrentSession.body, undefined);
  assert.equal(extendCurrentSession.response, undefined);
});
