// Tenant text overrides (PRD v1.7 §3 F4 "Teks & Kamus Istilah", §6 A
// `text_overrides`): catalog-validated keys, versioned rows, audit, tenant
// isolation. TEN-10 names the Whitelabel acceptance this belongs to (tenant
// terminology is part of the whitelabel surface).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textOverrideInputSchema } from "@starter/shared/text";
import {
  listTextOverrides,
  putTextOverride,
} from "../services/text-override.service";
import {
  createTestTenant,
  owner,
  removeTestTenant,
  type TestTenant,
} from "./platform-theme-helpers";

let a: TestTenant;
let b: TestTenant;

const put = (t: TestTenant, value: string, key = "terms.wfcZone") =>
  putTextOverride(
    t.context,
    textOverrideInputSchema.parse({ locale: "id", key, value }),
    t.actorId,
  );

beforeAll(async () => {
  a = await createTestTenant("teks-a");
  b = await createTestTenant("teks-b");
});

afterAll(async () => {
  await removeTestTenant(a);
  await removeTestTenant(b);
  await owner.end();
});

describe("TEN-10 text overrides (tenant dictionary)", () => {
  it("TEN-10 rejects keys outside the text catalog and tenant fields in the body", () => {
    expect(
      textOverrideInputSchema.safeParse({
        locale: "id",
        key: "terms.doesNotExist",
        value: "x",
      }).success,
    ).toBe(false);
    expect(
      textOverrideInputSchema.safeParse({
        locale: "id",
        key: "terms.wfcZone",
        value: "Ruang Kerja",
        tenantId: b.tenantId,
      }).success,
    ).toBe(false);
  });

  it("TEN-10 versions an override on every change and audits it", async () => {
    const first = await put(a, "Ruang Kerja");
    expect(first.version).toBe(1);
    const same = await put(a, "Ruang Kerja");
    expect(same.version).toBe(1);
    const second = await put(a, "Ruang Fokus");
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(2);
    expect(second.value).toBe("Ruang Fokus");

    const { rows } = await owner.query(
      "SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND event->>'action' LIKE 'text_override.%'",
      [a.tenantId],
    );
    expect(rows[0].n).toBe(2);
  });

  it("TEN-01 TEN-10 one tenant's overrides never appear for another tenant", async () => {
    await put(b, "Zona B", "terms.table");
    const listA = await listTextOverrides(a.context, {});
    expect(listA.data.every((o) => o.tenantId === a.tenantId)).toBe(true);
    expect(listA.data.map((o) => o.key)).not.toContain("terms.table");
    const listB = await listTextOverrides(b.context, { locale: "id" });
    expect(listB.data.map((o) => o.value)).toEqual(["Zona B"]);
    // Same key in both tenants stays independent (unique includes tenant_id).
    await put(a, "Meja A", "terms.table");
    expect((await listTextOverrides(b.context, {})).data[0]?.value).toBe(
      "Zona B",
    );
  });
});
