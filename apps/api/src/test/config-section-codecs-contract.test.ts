// legend-tct8: contract tests for the TEN-09 config bundle section codecs
// (PRD v1.7 §3 F4 "Konfigurasi sebagai Data"). Written from the shared
// validators (`@starter/shared/platform`), not from any service code.
//
// Contract under test:
//   - `CONFIG_SECTION_CODECS` has one codec per generic section
//     (GENERIC_CONFIG_SECTIONS): `{section, version, itemSchema, toTemplate,
//     fromTemplate}`.
//   - `toTemplate` output carries no tenant/source identifier.
//   - `fromTemplate(toTemplate(rows))` round-trips into id-less drafts.
//   - Each `itemSchema` rejects items that carry an id.
//
// Assumptions (spec silent): a codec with no rows exports `[]` and imports
// `[]` as `{ ok: true, drafts: [] }`; `fromTemplate` of `toTemplate` output of
// a section whose domain fixtures are not in the shared package is checked
// with the `zones` items of the platform fixture bundle plus the empty case.
import { describe, expect, it } from "vitest";
import {
  cafeLegendAccessFixtures as acc,
  roleConfigKeys,
} from "@starter/shared/access";
import { cafeLegendAccountingFixtures as books } from "@starter/shared/accounting";
import {
  CONFIG_SECTION_CODECS,
  GENERIC_CONFIG_SECTIONS,
  cafeLegendPlatformFixtures,
  configSectionCodec,
  configSectionItemSchemas,
  findBundleIdentifiers,
} from "@starter/shared/platform";

const SOURCE_IDS = [acc.tenantId, books.tenantId, books.legalEntity.id];
const ID_KEYS = [
  "id",
  "tenantId",
  "outletId",
  "brandId",
  "legalEntityId",
  "createdBy",
] as const;

// The registry is typed per registered section; the contract is uniform, so
// treat codecs structurally here.
type AnyCodec = {
  section: string;
  version: number;
  itemSchema: {
    safeParse: (v: unknown) => { success: boolean };
    parse: (v: unknown) => unknown;
  };
  toTemplate: (rows: readonly never[], ctx?: never) => unknown[];
  fromTemplate: (
    items: readonly never[],
    ctx?: never,
  ) => { ok: boolean; drafts?: unknown[]; issues?: string[] };
};
const registry = CONFIG_SECTION_CODECS as unknown as Record<string, AnyCodec>;
const call = <T>(fn: (...args: never[]) => T, ...args: unknown[]): T =>
  fn(...(args as never[]));

const CODEC_SECTIONS = GENERIC_CONFIG_SECTIONS;

// These sections have domain-owned codecs (`*/config-codec.ts`, each with its
// own context and per-codec tests in tests/platform-config-codecs-*.test.mjs
// and tests/config-codec-checklists.test.mjs). The registry, empty-import and
// id-refusal checks below still cover them; the (rows, ctx) round-trips do not.
const DOMAIN_CODEC_SECTIONS = [
  "tax_rules",
  "service_charge_rules",
  "zones",
  "checklists",
  "loyalty_policy",
  "facilities",
  "payroll_settings",
] as const;
const SHARED_SIGNATURE_SECTIONS = CODEC_SECTIONS.filter(
  (section) => !(DOMAIN_CODEC_SECTIONS as readonly string[]).includes(section),
);

// loyalty_policy needs a point-value lock decision and a `kind` item; its own
// tests are tests/platform-config-codecs-loyalty-policy.test.mjs.
const GENERIC_ITEM_SECTIONS = CODEC_SECTIONS.filter(
  (section) => section !== "loyalty_policy",
);

const roleKeyById = roleConfigKeys(acc.roles);
const roleKeys = new Set(roleKeyById.values());

describe("legend-tct8 registry", () => {
  it("lists the eleven generic sections", () => {
    expect([...GENERIC_CONFIG_SECTIONS].sort()).toEqual(
      [
        "approval_policies",
        "chart_of_accounts",
        "checklists",
        "facilities",
        "loyalty_policy",
        "payroll_settings",
        "roles",
        "service_charge_rules",
        "tax_rules",
        "wifi_policies",
        "zones",
      ].sort(),
    );
  });

  it.each([...CODEC_SECTIONS])(
    "%s has a codec with the toTemplate/fromTemplate interface",
    (section) => {
      const codec = registry[section];
      expect(codec, `no codec registered for ${section}`).toBeDefined();
      expect(codec.section).toBe(section);
      expect(Number.isInteger(codec.version)).toBe(true);
      expect(codec.version).toBeGreaterThan(0);
      expect(typeof codec.toTemplate).toBe("function");
      expect(typeof codec.fromTemplate).toBe("function");
      expect(typeof codec.itemSchema.safeParse).toBe("function");
      expect(configSectionCodec(section)).toBe(codec);
    },
  );

  it("registers no section outside the generic list", () => {
    for (const section of Object.keys(CONFIG_SECTION_CODECS))
      expect(GENERIC_CONFIG_SECTIONS).toContain(section);
  });
});

describe("legend-tct8 toTemplate is tenant-free", () => {
  it("roles", () => {
    const codec = registry.roles;
    const items = call(codec.toTemplate, acc.roles);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) codec.itemSchema.parse(item);
    expect(findBundleIdentifiers(items, SOURCE_IDS)).toEqual([]);
  });

  it("approval_policies (approver by role key, not role id)", () => {
    const codec = registry.approval_policies;
    const items = call(codec.toTemplate, acc.approvalPolicies, { roleKeyById });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) codec.itemSchema.parse(item);
    expect(findBundleIdentifiers(items, SOURCE_IDS)).toEqual([]);
  });

  it("chart_of_accounts (parent by key, not account id)", () => {
    const codec = registry.chart_of_accounts;
    const items = call(codec.toTemplate, books.accounts);
    expect(items.length).toBe(books.accounts.length);
    for (const item of items) codec.itemSchema.parse(item);
    expect(findBundleIdentifiers(items, SOURCE_IDS)).toEqual([]);
  });

  it.each([...SHARED_SIGNATURE_SECTIONS])(
    "%s exports an empty section as []",
    (section) => {
      const codec = registry[section];
      expect(codec, `no codec registered for ${section}`).toBeDefined();
      const ctx = section === "approval_policies" ? { roleKeyById } : undefined;
      expect(call(codec.toTemplate, [], ctx)).toEqual([]);
    },
  );
});

describe("legend-tct8 fromTemplate round-trips", () => {
  it("roles: id-less drafts that export back to the same items", () => {
    const codec = registry.roles;
    const items = call(codec.toTemplate, acc.roles);
    const decoded = call(codec.fromTemplate, items);
    expect(decoded.ok).toBe(true);
    expect(decoded.drafts).toHaveLength(items.length);
    for (const draft of decoded.drafts ?? [])
      for (const key of [...ID_KEYS, "createdAt", "updatedAt"])
        expect(draft).not.toHaveProperty(key);
    // Stable: same rows, same items.
    expect(call(codec.toTemplate, acc.roles)).toEqual(items);
  });

  it("approval_policies: id-less drafts, one per policy", () => {
    const codec = registry.approval_policies;
    const items = call(codec.toTemplate, acc.approvalPolicies, { roleKeyById });
    const decoded = call(codec.fromTemplate, items, { roleKeys });
    expect(decoded.ok).toBe(true);
    expect(decoded.drafts).toHaveLength(acc.approvalPolicies.length);
    for (const draft of decoded.drafts ?? []) {
      for (const key of [...ID_KEYS, "approverRoleId"])
        expect(draft).not.toHaveProperty(key);
    }
  });

  it("chart_of_accounts: id-less drafts, one per account", () => {
    const codec = registry.chart_of_accounts;
    const items = call(codec.toTemplate, books.accounts);
    const decoded = call(codec.fromTemplate, items);
    expect(decoded.ok).toBe(true);
    expect(decoded.drafts).toHaveLength(books.accounts.length);
    for (const draft of decoded.drafts ?? [])
      for (const key of [...ID_KEYS, "parentId"])
        expect(draft).not.toHaveProperty(key);
  });

  it.each([...GENERIC_ITEM_SECTIONS])(
    "%s imports an empty section as no drafts",
    (section) => {
      const codec = registry[section];
      expect(codec, `no codec registered for ${section}`).toBeDefined();
      const ctx = section === "approval_policies" ? { roleKeys } : undefined;
      const decoded = call(codec.fromTemplate, [], ctx);
      expect(decoded.ok).toBe(true);
      expect(decoded.drafts).toEqual([]);
    },
  );
});

describe("legend-tct8 item schemas refuse ids", () => {
  const baseItem = (section: string): Record<string, unknown> | undefined => {
    switch (section) {
      case "roles":
        return call(registry.roles.toTemplate, acc.roles)[0] as never;
      case "approval_policies":
        return call(
          registry.approval_policies.toTemplate,
          acc.approvalPolicies,
          {
            roleKeyById,
          },
        )[0] as never;
      case "chart_of_accounts":
        return call(
          registry.chart_of_accounts.toTemplate,
          books.accounts,
        )[0] as never;
      case "zones":
        return (
          cafeLegendPlatformFixtures.configBundle.sections.zones as {
            items: Record<string, unknown>[];
          }
        ).items[0];
      default:
        return undefined; // no known valid item without domain fixtures
    }
  };

  it.each([...GENERIC_ITEM_SECTIONS])(
    "%s codec item schema rejects an id-bearing item",
    (section) => {
      const codec = registry[section];
      expect(codec, `no codec registered for ${section}`).toBeDefined();
      const base = baseItem(section);
      if (base) expect(codec.itemSchema.safeParse(base).success).toBe(true);
      for (const key of ID_KEYS) {
        expect(
          codec.itemSchema.safeParse({
            ...(base ?? { key: "x" }),
            [key]: crypto.randomUUID(),
          }).success,
          `${section} accepted ${key}`,
        ).toBe(false);
      }
    },
  );

  it.each([...GENERIC_ITEM_SECTIONS])(
    "%s bundle item schema agrees with the codec item schema",
    (section) => {
      const base = baseItem(section);
      if (!base) return;
      const idItem = { ...base, id: crypto.randomUUID() };
      expect(configSectionItemSchemas[section].safeParse(idItem).success).toBe(
        false,
      );
    },
  );
});

describe("legend-tct8 review hardening", () => {
  const wifiItem = {
    key: "default",
    outletKey: "main",
    zoneKey: "dining",
    facilityKey: null,
    freeMinutes: 60,
    peakFreeMinutes: 30,
    spendPerExtraHourIdr: 50_000,
    extraMinutes: 60,
    maxDevices: 3,
    peakSchedule: [],
    baseSpeedKbps: 2000,
    fullSpeedKbps: 10_000,
    minSpendPerHourIdr: null,
    tierBonusMinutes: { gold: 60 },
  };
  const wifiSchema = configSectionItemSchemas.wifi_policies;

  it("wifi_policies: the plain item is valid (control)", () => {
    expect(wifiSchema.safeParse(wifiItem).success).toBe(true);
  });

  it("wifi_policies: tierBonusMinutes keys are 1 to 30 characters", () => {
    for (const tier of ["", "x".repeat(31)])
      expect(
        wifiSchema.safeParse({ ...wifiItem, tierBonusMinutes: { [tier]: 10 } })
          .success,
        `tier key length ${tier.length}`,
      ).toBe(false);
    expect(
      wifiSchema.safeParse({
        ...wifiItem,
        tierBonusMinutes: { ["x".repeat(30)]: 10 },
      }).success,
    ).toBe(true);
  });

  it("item keys that look like a UUID are refused", () => {
    const zone = (
      cafeLegendPlatformFixtures.configBundle.sections.zones as {
        items: Record<string, unknown>[];
      }
    ).items[0];
    expect(configSectionItemSchemas.zones.safeParse(zone).success).toBe(true);
    expect(
      configSectionItemSchemas.zones.safeParse({
        ...zone,
        key: crypto.randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      wifiSchema.safeParse({ ...wifiItem, zoneKey: crypto.randomUUID() })
        .success,
    ).toBe(false);
  });

  it("findBundleIdentifiers flags a UUID used as an object key", () => {
    const id = crypto.randomUUID();
    const issues = findBundleIdentifiers({
      sections: {
        wifi_policies: { items: [{ tierBonusMinutes: { [id]: 5 } }] },
      },
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.path.includes(id))).toBe(true);
  });

  it("findBundleIdentifiers flags a source id used as an object key", () => {
    const issues = findBundleIdentifiers({ perTenant: { [acc.tenantId]: 1 } }, [
      acc.tenantId,
    ]);
    expect(issues.length).toBeGreaterThan(0);
  });

  it("findBundleIdentifiers stays clean for ordinary keys", () => {
    expect(
      findBundleIdentifiers({ tierBonusMinutes: { gold: 60 } }, [acc.tenantId]),
    ).toEqual([]);
  });
});
