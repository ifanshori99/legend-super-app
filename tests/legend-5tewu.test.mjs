// legend-5tewu: settings explain WhatsApp number conflicts without leaking
// a server's raw error text or changing ordinary validation failures.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/"))
      return nextResolve(
        new URL(`../apps/web/src/${specifier.slice(2)}.ts`, import.meta.url)
          .href,
        context,
      );
    return nextResolve(specifier, context);
  },
});

const { settingsErrorMessage } =
  await import("../apps/web/src/features/ws01-tenant-settings/errors.ts");
const { tenantSettingsMessages } =
  await import("../packages/shared/src/i18n/messages/ws01-tenant-settings.ts");
const translate = (key) => key;

test("legend-5tewu maps a 409 WhatsApp number conflict to dedicated catalog copy", () => {
  const failure = new ApiError(
    409,
    "WHATSAPP_NUMBER_TAKEN",
    "Private tenant and submitted number must not be displayed",
  );
  assert.equal(
    settingsErrorMessage(failure, translate),
    "tenantSettings.errors.whatsappNumberTaken",
  );
  assert.ok(tenantSettingsMessages.errors.whatsappNumberTaken);
});

test("legend-5tewu keeps 422 validation and generic failures safely translated", () => {
  assert.equal(
    settingsErrorMessage(
      new ApiError(422, "VALIDATION_ERROR", "Private invalid number"),
      translate,
    ),
    "tenantSettings.errors.invalid",
  );
  assert.equal(
    settingsErrorMessage(new Error("Private unknown failure"), translate),
    "tenantSettings.errors.generic",
  );
});
