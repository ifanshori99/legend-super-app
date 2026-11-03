// legend-ovi8: staff-recorded consents may only use source cashier or import.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STAFF_CONSENT_SOURCES,
  isStaffConsentSourceAllowed,
  staffConsentSourceSchema,
} from "../packages/shared/src/crm/consent-sources.ts";
import { consentSourceSchema } from "../packages/shared/src/crm/loyalty.ts";
import {
  PERMISSION_CODES,
  ROLE_TEMPLATES,
  permissionHasTag,
} from "../packages/shared/src/access/index.ts";

test("staff may record cashier and import sources only", () => {
  assert.deepEqual([...STAFF_CONSENT_SOURCES], ["cashier", "import"]);
  assert.equal(isStaffConsentSourceAllowed("cashier"), true);
  assert.equal(isStaffConsentSourceAllowed("import"), true);
  for (const source of ["member_pwa", "website", "", "other", null, 1])
    assert.equal(isStaffConsentSourceAllowed(source), false, String(source));
  assert.equal(staffConsentSourceSchema.safeParse("website").success, false);
});

test("every staff source is a valid consent source", () => {
  for (const source of STAFF_CONSENT_SOURCES)
    assert.ok(consentSourceSchema.safeParse(source).success);
});

test("crm.consent.record is a write permission held by the agreed templates", () => {
  assert.ok(PERMISSION_CODES.includes("crm.consent.record"));
  assert.equal(permissionHasTag("crm.consent.record", "customer_pii"), false);
  const holders = ROLE_TEMPLATES.filter((r) =>
    r.permissions.includes("crm.consent.record"),
  )
    .map((r) => r.key)
    .sort();
  assert.deepEqual(holders, [
    "cashier",
    "marketing",
    "outlet_manager",
    "owner", // owner holds the whole tenant catalog
    "tenant_admin",
  ]);
});
