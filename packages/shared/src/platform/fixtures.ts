// Cafe Legend platform fixtures (FE mock mode + contract tests). PRD facts:
// tenant Cafe Legend in Kota Bandung, operated by PT Sultan Solusi
// Nusantara; Super Admin is Ilham plus one break-glass account; default
// support session 60 minutes; Legend needs at least 30 active employees.
// Package names, quotas, caps, hostnames, integration settings and usage
// numbers are illustrative sample data, not PRD facts or owner decisions.
// Ids reuse the core, accounting and access fixtures so cross-domain mocks
// join up.

import { fixtureTimeAfter } from "../core/fixture-clock.ts";
import { cafeLegendFixtures } from "../core/index.ts";
import { cafeLegendAccessFixtures } from "../access/fixtures.ts";
import { cafeLegendTextFixtures } from "../text/fixtures.ts";
import { cafeLegendTheme } from "../theme/tenants/cafe-legend.ts";
import { failingThemeExample } from "../theme/tenants/failing-example.ts";
import { configBundleSchema, configTemplateSchema } from "./config.ts";
import { brandContextSchema } from "./context.ts";
import { tenantDomainSchema } from "./domains.ts";
import { tenantIntegrationSchema } from "./integrations.ts";
import { tenantUsageSchema } from "./limits.ts";
import {
  MODULE_KEYS,
  isModuleEnabled,
  platformPackageSchema,
} from "./modules.ts";
import {
  brandSchema,
  legalEntitySchema,
  outletSchema,
  platformAdminSchema,
  tenantSchema,
} from "./org.ts";
import { supportAccessGrantSchema } from "./support-access.ts";
import { tenantThemeSchema } from "./themes.ts";
import type { ThemeTokens } from "./themes.ts";

function fixedId(prefix: string, n: number): string {
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const core = cafeLegendFixtures;
const users = cafeLegendAccessFixtures.users;
const SEEDED_AT = "2026-10-15T02:00:00.000Z";
/** Same clock as the access fixtures: inside the active support session. */
const NOW = "2026-11-01T05:00:00.000Z";

const superAdmin = { id: fixedId("5a5a0000", 1), displayName: "Ilham" };
const breakGlass = {
  id: fixedId("5a5a0000", 2),
  displayName: "Super Admin cadangan",
};

const platformAdmins = [
  { id: fixedId("9a0d0000", 1), userId: superAdmin.id, isBreakGlass: false },
  { id: fixedId("9a0d0000", 2), userId: breakGlass.id, isBreakGlass: true },
].map((row) =>
  platformAdminSchema.parse({ ...row, grantedAt: SEEDED_AT, revokedAt: null }),
);

const fullLimits = {
  maxOutlets: 5,
  maxActiveEmployees: 30,
  maxDevices: 40,
  aiRequestsPerMonth: 2_000,
  // WhatsApp template/replies are off by default (PRD §2): cap 0 = stopped.
  whatsappCostCapIdr: 0,
  aiCostCapIdr: 300_000,
  emailCostCapIdr: 50_000,
};

const packages = [
  {
    key: "lengkap",
    name: "Paket Lengkap",
    modules: [...MODULE_KEYS],
    defaultLimits: fullLimits,
    status: "active",
  },
  {
    key: "outlet-dasar",
    name: "Paket Outlet Dasar",
    modules: ["pos", "qr_order", "kds", "inventory", "loyalty"],
    defaultLimits: {
      ...fullLimits,
      maxOutlets: 1,
      maxActiveEmployees: 15,
      maxDevices: 10,
      aiRequestsPerMonth: 0,
      aiCostCapIdr: 0,
    },
    status: "active",
  },
].map((row) => platformPackageSchema.parse(row));

const tenant = tenantSchema.parse({
  id: core.tenant.id,
  slug: core.tenant.slug,
  name: core.tenant.name,
  plan: "lengkap",
  status: "active",
  deploymentMode: "dedicated",
  featureFlags: {
    // Shareholder dashboard stays off until its milestone (sample). MCP is on:
    // the `mcp` module gates every MCP path (981 / legend-hbuq3).
    modules: MODULE_KEYS.filter((module) => module !== "shareholder_dashboard"),
    integrationProviders: ["doit", "whatsapp", "email", "gofood", "edc", "llm"],
  },
  limits: {
    ...fullLimits,
    maxActiveEmployees: 40,
    whatsappCostCapIdr: 150_000,
  },
  createdBy: superAdmin.id,
  createdAt: SEEDED_AT,
});

/** A suspended second tenant, to show the registry and host checks. */
const suspendedTenant = tenantSchema.parse({
  ...tenant,
  id: fixedId("7e7a0000", 2),
  slug: "kopi-contoh",
  name: "Kopi Contoh",
  plan: "outlet-dasar",
  status: "suspended",
  deploymentMode: "shared",
  featureFlags: { modules: ["pos", "qr_order"], integrationProviders: [] },
  limits: packages[1].defaultLimits,
});

const themeIds = [fixedId("7e3e0000", 1), fixedId("7e3e0000", 2)];

const brand = brandSchema.parse({
  id: core.brand.id,
  tenantId: tenant.id,
  slug: core.brand.slug,
  name: core.brand.name,
  logoMediaId: null, // A1 brand assets pending
  themeId: themeIds[0],
  primaryHostname: "pesan.cafelegend.example",
  createdAt: SEEDED_AT,
});

const legalEntity = legalEntitySchema.parse({
  // Same id as the accounting fixtures' legal entity.
  id: "5e1a7c30-4b2d-4e8f-9a61-3c7d2b8e0f14",
  tenantId: tenant.id,
  name: core.legalEntityName,
  npwpLast4: null, // NPWP not provided yet (owner data, PRD A14)
  isPkp: false, // illustrative until the owner confirms PKP status
  address: "Kota Bandung, Jawa Barat",
  bankAccountIds: [],
  createdAt: SEEDED_AT,
});

const cafeHours = { opens: "08:00", closes: "22:00" };
const weekendHours = { opens: "08:00", closes: "23:00" };
const openingHours = {
  mon: cafeHours,
  tue: cafeHours,
  wed: cafeHours,
  thu: cafeHours,
  fri: weekendHours,
  sat: weekendHours,
  sun: cafeHours,
};

const outlets = core.outlets.map((ref, index) =>
  outletSchema.parse({
    id: ref.id,
    tenantId: tenant.id,
    brandId: brand.id,
    legalEntityId: legalEntity.id,
    code: ref.code,
    name: ref.name,
    address:
      index === 0
        ? "Jl. Contoh Raya No. 1, Kota Bandung"
        : "Jl. Contoh Dua No. 2, Kota Bandung",
    regionId: null,
    geofence:
      index === 0
        ? { latitude: -6.9175, longitude: 107.6191, radiusMeters: 100 }
        : null,
    timeZone: ref.timeZone,
    businessDayCutoff: ref.businessDayCutoff,
    openingHours,
    edgeNodeId: null,
    status: ref.status,
    createdAt: SEEDED_AT,
  }),
);

const domains = [
  {
    id: fixedId("d0a10000", 1),
    hostname: "cafe-legend.platform.example",
    kind: "platform_subdomain",
    tlsStatus: "active",
    verifiedAt: SEEDED_AT,
  },
  {
    id: fixedId("d0a10000", 2),
    hostname: "pesan.cafelegend.example",
    kind: "custom",
    tlsStatus: "active",
    verifiedAt: "2026-10-16T03:00:00.000Z",
  },
  {
    id: fixedId("d0a10000", 3),
    hostname: "wfc.cafelegend.example",
    kind: "custom",
    tlsStatus: "pending",
    verifiedAt: null,
  },
].map((row) =>
  tenantDomainSchema.parse({
    ...row,
    tenantId: tenant.id,
    brandId: brand.id,
    verification: null,
    createdAt: SEEDED_AT,
  }),
);
const suspendedDomain = tenantDomainSchema.parse({
  id: fixedId("d0a10000", 4),
  tenantId: suspendedTenant.id,
  brandId: fixedId("b4a40000", 2),
  hostname: "kopi-contoh.platform.example",
  kind: "platform_subdomain",
  tlsStatus: "active",
  verifiedAt: SEEDED_AT,
  verification: null,
  createdAt: SEEDED_AT,
});

const credentials = (n: number, fields: string[]) => ({
  secretRef: `sec_cafelegend_${n.toString().padStart(4, "0")}_ref`,
  fields,
  setAt: SEEDED_AT,
  setBy: users.tenantAdmin.id,
});

const integrations = [
  {
    id: fixedId("1a7e0000", 1),
    outletId: null,
    provider: "doit",
    config: { environment: "sandbox", merchantName: "Cafe Legend" },
    credentials: credentials(1, ["apiKey", "webhookSecret"]),
    status: "active",
  },
  {
    id: fixedId("1a7e0000", 2),
    outletId: null,
    provider: "whatsapp",
    config: { vendor: "kirimdev", receivingNumber: "6281234500001" },
    credentials: credentials(2, ["apiKey", "webhookSecret"]),
    status: "active",
  },
  {
    id: fixedId("1a7e0000", 3),
    outletId: null,
    provider: "email",
    config: { senderAddress: "halo@cafelegend.example" },
    credentials: null,
    status: "draft",
  },
  {
    id: fixedId("1a7e0000", 4),
    outletId: outlets[0].id,
    provider: "edc",
    config: { bank: "bca", terminalLabel: "EDC BCA Kasir 1" },
    credentials: credentials(4, ["terminalKey"]),
    status: "active",
  },
].map((row) =>
  tenantIntegrationSchema.parse({
    ...row,
    tenantId: tenant.id,
    lastCheckedAt: row.status === "active" ? NOW : null,
    lastErrorCode: null,
    updatedAt: SEEDED_AT,
  }),
);

const legendTokens: ThemeTokens = {
  light: { ...cafeLegendTheme.colors.light },
  dark: { ...cafeLegendTheme.colors.dark },
};
const failingTokens: ThemeTokens = {
  light: { ...failingThemeExample.colors.light },
  dark: { ...failingThemeExample.colors.dark },
};

const themes = [
  {
    id: themeIds[0],
    version: 1,
    tokens: legendTokens,
    contrastCheckPassed: true,
    status: "active",
    activatedAt: SEEDED_AT,
  },
  {
    // A draft the editor saved with a pale primary: activation must fail.
    id: themeIds[1],
    version: 2,
    tokens: failingTokens,
    contrastCheckPassed: false,
    status: "draft",
    activatedAt: null,
  },
].map((row) =>
  tenantThemeSchema.parse({
    ...row,
    tenantId: tenant.id,
    brandId: brand.id,
    logoMediaId: null,
    fontFamily: cafeLegendTheme.font ?? "plus-jakarta-sans",
    corners: cafeLegendTheme.corners ?? "lembut",
    createdBy: users.tenantAdmin.id,
    createdAt: SEEDED_AT,
  }),
);

/** What the web server renders SSR with; brand only, no platform identity. */
const brandContext = brandContextSchema.parse({
  brand: {
    id: brand.id,
    slug: brand.slug,
    name: brand.name,
    logoMediaId: brand.logoMediaId,
  },
  theme: {
    tokens: themes[0].tokens,
    fontFamily: themes[0].fontFamily,
    corners: themes[0].corners,
  },
  enabledModules: MODULE_KEYS.filter((key) =>
    isModuleEnabled(tenant.featureFlags, key),
  ),
});

const supportGrants = [
  {
    id: fixedId("5ac0000a", 1),
    reason:
      "Memeriksa laporan selisih kas outlet BDG-01 atas permintaan owner.",
    accessMode: "read_only",
    durationMinutes: 60,
    startedAt: "2026-10-28T03:00:00.000Z",
    expiresAt: "2026-10-28T04:00:00.000Z",
    mfaVerifiedAt: "2026-10-28T02:59:30.000Z",
    tenantAdminNotifiedAt: "2026-10-28T03:00:01.000Z",
    endedAt: null,
    endedBy: null,
  },
  {
    id: fixedId("5ac0000a", 2),
    reason:
      "Membantu admin tenant memeriksa pengaturan pajak yang tidak tampil di struk.",
    accessMode: "read_only",
    durationMinutes: 60,
    startedAt: "2026-11-01T04:30:00.000Z",
    expiresAt: fixtureTimeAfter({ minutes: 30 }, NOW),
    mfaVerifiedAt: "2026-11-01T04:29:40.000Z",
    tenantAdminNotifiedAt: "2026-11-01T04:30:01.000Z",
    endedAt: null,
    endedBy: null,
  },
].map((row) =>
  supportAccessGrantSchema.parse({
    ...row,
    tenantId: tenant.id,
    superAdminUserId: superAdmin.id,
  }),
);

const usage = tenantUsageSchema.parse({
  month: "2026-11",
  outlets: outlets.length,
  activeEmployees: 34,
  devices: 18,
  aiRequests: 420,
  whatsappCostIdr: 125_000, // 83% of the cap: warning state
  aiCostIdr: 90_000,
  emailCostIdr: 0,
});

const textSets = (["id", "en"] as const)
  .map((locale) => ({
    locale,
    overrides: cafeLegendTextFixtures.overrides
      .filter((row) => row.locale === locale)
      .map((row) => ({ key: row.key, value: row.value })),
  }))
  .filter((set) => set.overrides.length > 0);

const configBundle = configBundleSchema.parse({
  formatVersion: 1,
  exportedAt: NOW,
  sections: {
    modules: {
      version: 1,
      featureFlags: tenant.featureFlags,
      limits: tenant.limits,
    },
    text_overrides: { version: 1, sets: textSets },
    theme: {
      version: 1,
      tokens: legendTokens,
      fontFamily: themes[0].fontFamily,
      corners: themes[0].corners,
    },
    zones: {
      version: 1,
      items: [
        { key: "indoor", name: "Indoor" },
        { key: "outdoor", name: "Teras" },
        { key: "wfc", name: "Zona WFC" },
      ].map((zone, sortOrder) => ({
        ...zone,
        outletKey: outlets[0].code.toLowerCase(),
        paymentMode: "pay_first",
        serviceChargeBp: 0,
        minimumSpendIdr: 0,
        hours: [],
        status: "active",
        sortOrder,
      })),
    },
  },
});

const configTemplate = configTemplateSchema.parse({
  id: fixedId("c0f10000", 1),
  name: "Template Cafe Legend v1",
  sourceTenantId: tenant.id,
  version: 1,
  payload: configBundle,
  createdBy: superAdmin.id,
  createdAt: NOW,
});

export const cafeLegendPlatformFixtures = {
  now: NOW,
  superAdmin,
  breakGlass,
  platformAdmins,
  packages,
  tenant,
  suspendedTenant,
  brand,
  legalEntity,
  outlets,
  domains,
  suspendedDomain,
  brandContext,
  integrations,
  themes,
  supportGrants,
  usage,
  configBundle,
  configTemplate,
};
