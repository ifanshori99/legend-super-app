// legend-rp3fk: the email channel of the security category cannot be switched
// off (legend-307w3 contract: MANDATORY_EMAIL_CATEGORIES / isEmailMandatory).
// The mock of PUT /api/notifications/preferences refuses email=false for such a
// category with a 422 and keeps the stored preference untouched; every other
// category and channel stays free to change.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  MANDATORY_EMAIL_CATEGORIES,
  isEmailMandatory,
} from "../packages/shared/src/notification/index.ts";
import { registerWebAlias } from "./helpers/web-alias.mjs";

// The notifications mock imports through the web `@/` alias: register it first.
registerWebAlias();
const { dispatchMock, resetMocks } =
  await import("../apps/web/src/lib/mock/runtime.ts");
await import("../apps/web/src/features/ws05-notifications/mock.ts");

const request = (method, body) =>
  dispatchMock({ method, path: "/api/notifications/preferences", body });
const read = async () => (await request("GET")).data;
const bodyFrom = (preference, categories) => ({
  categories,
  quietHours: preference.quietHours,
  timeZone: preference.timeZone,
});

beforeEach(() => resetMocks());

describe("security email lock (legend-rp3fk)", () => {
  test("security is the mandatory-email category", () => {
    assert.ok(MANDATORY_EMAIL_CATEGORIES.includes("security"));
    assert.equal(isEmailMandatory("security"), true);
    assert.equal(isEmailMandatory("emergency"), false);
  });

  test("saving security with email off is a 422 and nothing is stored", async () => {
    const before = await read();
    await assert.rejects(
      request(
        "PUT",
        bodyFrom(before, {
          ...before.categories,
          security: { web_push: true, email: false, whatsapp: false },
        }),
      ),
      (error) => error.status === 422,
    );
    assert.deepEqual((await read()).categories, before.categories);
  });

  test("saving security with email on succeeds, other channels stay changeable", async () => {
    const before = await read();
    const saved = (
      await request(
        "PUT",
        bodyFrom(before, {
          ...before.categories,
          security: { web_push: false, email: true, whatsapp: false },
        }),
      )
    ).data;
    assert.equal(saved.categories.security.email, true);
    assert.equal(saved.categories.security.web_push, false);
    assert.equal((await read()).categories.security.email, true);
  });

  test("another category may switch its email off", async () => {
    const before = await read();
    const saved = (
      await request(
        "PUT",
        bodyFrom(before, {
          ...before.categories,
          security: { web_push: true, email: true, whatsapp: false },
          emergency: { web_push: true, email: false, whatsapp: false },
        }),
      )
    ).data;
    assert.equal(saved.categories.emergency.email, false);
  });
});
