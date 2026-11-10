// Share percentage permission (porsi saham). Pure catalog checks, no DB: the
// code exists with the finance tag, Owner and Finance hold it, cashier and
// shareholder do not, and it has an Indonesian label. It is separate from
// profit_share.registry.manage and profit_share.distribution.approve.
import { describe, expect, it } from "vitest";
import {
  PERMISSION_CATALOG,
  PERMISSION_CODES,
  isPermissionCode,
  roleTemplate,
} from "@starter/shared/access";
import { MESSAGE_KEYS, createTranslator } from "@starter/shared/i18n";

const CODE = "profit_share.share_allocation.change" as const;

describe(CODE, () => {
  it("is in the permission catalog tagged finance only", () => {
    expect(PERMISSION_CODES).toContain(CODE);
    expect(isPermissionCode(CODE)).toBe(true);
    expect(PERMISSION_CATALOG.find((p) => p.code === CODE)?.tags).toEqual([
      "finance",
    ]);
  });

  it.each(["owner", "finance"] as const)("%s template holds it", (key) => {
    expect(roleTemplate(key).permissions).toContain(CODE);
  });

  it.each(["cashier", "shareholder"] as const)(
    "%s template does not hold it",
    (key) => {
      expect(roleTemplate(key).permissions).not.toContain(CODE);
    },
  );

  it("is a different permission from registry.manage and distribution.approve", () => {
    expect(CODE).not.toBe("profit_share.registry.manage");
    expect(CODE).not.toBe("profit_share.distribution.approve");
  });

  it("has an Indonesian label that resolves", () => {
    const key = `access.permission.${CODE}`;
    expect(MESSAGE_KEYS).toContain(key);
    const label = createTranslator()(key as never);
    expect(label).not.toBe(key);
    expect(label.trim().length).toBeGreaterThan(0);
  });
});
