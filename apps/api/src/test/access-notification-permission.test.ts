// Notification admin permission (bead legend-kz1m, tier K: access). Pure
// catalog checks, no DB: the code exists, Owner and Admin Tenant hold it,
// operational templates do not, and it has an Indonesian label.
import { describe, expect, it } from "vitest";
import {
  PERMISSION_CATALOG,
  PERMISSION_CODES,
  isPermissionCode,
  permissionHasTag,
  permissionsRequireMfa,
  roleTemplate,
  type PermissionCode,
} from "@starter/shared/access";
import { MESSAGE_KEYS, createTranslator } from "@starter/shared/i18n";

const CODE = "org.notification_policy.manage" as const;

describe("org.notification_policy.manage", () => {
  it("is in the permission catalog with no sensitivity tags", () => {
    expect(PERMISSION_CODES).toContain(CODE);
    expect(isPermissionCode(CODE)).toBe(true);
    const entry = PERMISSION_CATALOG.find((p) => p.code === CODE);
    expect(entry?.tags).toEqual([]);
    expect(permissionHasTag(CODE, "platform")).toBe(false);
    expect(permissionsRequireMfa([CODE as PermissionCode])).toBe(false);
  });

  it.each(["owner", "tenant_admin"] as const)("%s template holds it", (key) => {
    expect(roleTemplate(key).permissions).toContain(CODE);
  });

  it.each(["shareholder", "cashier", "supervisor"] as const)(
    "%s template does not hold it",
    (key) => {
      expect(roleTemplate(key).permissions).not.toContain(CODE);
    },
  );

  it("has an Indonesian label that resolves", () => {
    const key = `access.permission.${CODE}`;
    expect(MESSAGE_KEYS).toContain(key);
    const label = createTranslator()(key as never);
    expect(label).not.toBe(key);
    expect(label.trim().length).toBeGreaterThan(0);
  });
});
