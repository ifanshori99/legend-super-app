// legend-85qyi: guard for the future loyalty_policy config import handler.
// Today the section is `unsupportedSection("loyalty_policy")` in
// services/tenant-config-core.ts: it rejects non-empty items. A program's legal
// entity (PT) is not part of the config bundle (Q80: points are per PT), so the
// codec never carries `legalEntityId`, and a handler that updates an existing
// program must OMIT `legalEntityId` from its update input, never write null.
// When the real handler lands, REPLACE the "still rejects" test below with one
// that proves an import over a program with a PT keeps that PT. No DB needed.
import { describe, expect, it } from "vitest";
import { CONFIG_SECTION_CODECS } from "@starter/shared/platform";
import { coreSectionHandlers } from "../services/tenant-config-core.ts";
import { ConfigImportError } from "../services/tenant-config-types.ts";

type AnyCodec = {
  section: string;
  itemSchema: { safeParse: (v: unknown) => { success: boolean } };
  toTemplate: (rows: unknown, ctx?: unknown) => Array<Record<string, unknown>>;
  fromTemplate: (
    items: readonly unknown[],
    ctx?: unknown,
  ) => {
    ok: boolean;
    drafts?: Array<Record<string, unknown>>;
    issues?: string[];
  };
};
const codec = (CONFIG_SECTION_CODECS as unknown as Record<string, AnyCodec>)
  .loyalty_policy;

const LEGAL_ENTITY_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const programItem = {
  key: "program.main",
  kind: "program",
  name: "Poin Member",
  earnRate: { spendIdr: 10_000, points: 1 },
  expiryMonths: 12,
  rollingMonths: 12,
  pointValueIdr: 100,
  referral: {
    enabled: false,
    referrerPoints: 100,
    refereePoints: 50,
    qualifyingEvent: "first_paid_order",
    minFirstOrderIdr: 0,
    maxReferralsPerCustomerPerMonth: 10,
  },
  antiFraud: { dailyPointCapPerCustomer: 500, employeeSelfServeBan: true },
  isActive: false,
};
const decodeContext = { lockedPointValueIdr: null, menuItemKeys: new Set() };

const handler = () => {
  const found = coreSectionHandlers.find(
    (item) => item.section === "loyalty_policy",
  );
  if (!found) throw new Error("loyalty_policy handler must be registered");
  return found;
};

describe("legend-85qyi loyalty_policy import guard", () => {
  it("still rejects non-empty items; a real handler must replace this test", async () => {
    await expect(
      handler().importSection({} as never, { items: [programItem] }),
    ).rejects.toBeInstanceOf(ConfigImportError);
  });

  it("accepts an empty or absent payload and exports nothing", async () => {
    await expect(
      handler().importSection({} as never, { items: [] }),
    ).resolves.toBeUndefined();
    await expect(
      handler().importSection({} as never, undefined),
    ).resolves.toBeUndefined();
    await expect(handler().exportSection({} as never)).resolves.toBeUndefined();
  });

  it("decode never yields legalEntityId and refuses it (null or a value)", () => {
    const decoded = codec.fromTemplate([programItem], decodeContext);
    expect(decoded.ok).toBe(true);
    expect(decoded.drafts).toHaveLength(1);
    expect("legalEntityId" in (decoded.drafts?.[0] ?? {})).toBe(false);
    for (const legalEntityId of [LEGAL_ENTITY_ID, null]) {
      const item = { ...programItem, legalEntityId };
      expect(codec.itemSchema.safeParse(item).success).toBe(false);
      expect(codec.fromTemplate([item], decodeContext).ok).toBe(false);
    }
  });

  it("encode drops the PT of an exported program", () => {
    const programFields: Record<string, unknown> = { ...programItem };
    delete programFields.key;
    delete programFields.kind;
    const exported = codec.toTemplate({
      programs: [
        {
          ...programFields,
          id: "33333333-3333-4333-8333-333333333333",
          tenantId: TENANT_ID,
          legalEntityId: LEGAL_ENTITY_ID,
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    });
    expect(exported).toHaveLength(1);
    expect("legalEntityId" in exported[0]!).toBe(false);
    expect(JSON.stringify(exported)).not.toContain(LEGAL_ENTITY_ID);
    expect(JSON.stringify(exported)).not.toContain(TENANT_ID);
  });
});
