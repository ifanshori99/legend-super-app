// Mock mode for the tenant settings screens (VITE_API_MOCK=true): the same
// answers the API will give, from @starter/shared fixtures.
//
// PAY-06: the integration handlers read credential FIELD NAMES from a request
// and drop the values at once; no response, store row or log line carries one.
// Scenarios (loading / empty / error / offline) come from the shared mock
// control (`?mock=empty|slow|error|offline`). Brand and outlet lookups are
// served by the access and accounting mocks.
import type { z } from "zod";
import { themeCheckResultSchema } from "@starter/shared/platform";
import {
  PlatformError,
  activateTheme,
  canTransitionIntegration,
  cafeLegendPlatformFixtures,
  checkThemeTokens,
  configImportSchema,
  configBundleSchema,
  parseConfigBundle,
  tenantIntegrationSchema,
  tenantThemeSchema,
  orgEndpoints,
  textOverrideEndpoints,
  textOverrideRecordSchema,
  type ConfigBundle,
  type ConfigSection,
  type TenantIntegration,
  type TenantTheme,
  type TextOverrideRecord,
} from "@starter/shared/platform";
import { COLOR_TOKENS } from "@starter/shared/theme";
import { cafeLegendTextFixtures } from "@starter/shared/text";
import { ApiError } from "@/lib/api/errors";
import { newIdempotencyKey } from "@/lib/idempotency";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { deleteTextOverride, importOrgConfig } from "./endpoints";

const fixtures = cafeLegendPlatformFixtures;
const nowIso = () => new Date().toISOString();
// A plain-http LAN origin has no crypto.randomUUID; the seed runs at module
// load, so an unguarded call would break every mock handler (legend-zrdy).
const newId = () => newIdempotencyKey();
const newSecretRef = () => `sec_${newId().replaceAll("-", "")}`;
const actorId = fixtures.integrations[0]!.credentials!.setBy;

// ------------------------------------------------------------- integrations

const integrations = createMockStore<TenantIntegration[]>(() => [
  ...fixtures.integrations,
  // One delivery-app account so the "ojol" group is not empty in the demo.
  tenantIntegrationSchema.parse({
    id: newId(),
    tenantId: fixtures.tenant.id,
    outletId: null,
    provider: "gofood",
    config: { storeId: "G-10293847", accountLabel: "Cafe Legend Bandung" },
    credentials: {
      secretRef: newSecretRef(),
      fields: ["clientId", "clientSecret"],
      setAt: fixtures.now,
      setBy: actorId,
    },
    status: "disabled",
    lastCheckedAt: null,
    lastErrorCode: null,
    updatedAt: fixtures.now,
  }),
]);

registerMock(orgEndpoints.listIntegrations, ({ scenario }) => ({
  data: scenario === "empty" ? [] : integrations.get(),
}));

registerMock(orgEndpoints.upsertIntegration, ({ body }) => {
  const existing = integrations
    .get()
    .find(
      (row) =>
        row.provider === body.provider &&
        (row.outletId ?? null) === (body.outletId ?? null),
    );
  // The values are read for their names only; nothing below stores or returns them.
  const credentialFields = body.credentials
    ? Object.keys(body.credentials)
    : null;
  const credentials = credentialFields
    ? {
        secretRef: newSecretRef(),
        fields: credentialFields,
        setAt: nowIso(),
        setBy: actorId,
      }
    : (existing?.credentials ?? null);
  const row = tenantIntegrationSchema.parse({
    id: existing?.id ?? newId(),
    tenantId: fixtures.tenant.id,
    outletId: body.outletId,
    provider: body.provider,
    config: body.config,
    credentials,
    status: existing?.status ?? "draft",
    lastCheckedAt: existing?.lastCheckedAt ?? null,
    lastErrorCode: null,
    updatedAt: nowIso(),
  });
  integrations.set(
    existing
      ? integrations.get().map((item) => (item.id === row.id ? row : item))
      : [...integrations.get(), row],
  );
  return { data: row };
});

registerMock(orgEndpoints.setIntegrationStatus, ({ params, body }) => {
  const row = integrations
    .get()
    .find((item) => item.id === params.integrationId);
  if (!row) throw new ApiError(404, "NOT_FOUND", "Integrasi tidak ditemukan.");
  if (
    !canTransitionIntegration(row.status, body.status, row.credentials !== null)
  )
    throw new ApiError(
      409,
      "INVALID_TRANSITION",
      "Perubahan status ini tidak diizinkan.",
    );
  const next = tenantIntegrationSchema.parse({
    ...row,
    status: body.status,
    lastCheckedAt: body.status === "active" ? nowIso() : row.lastCheckedAt,
    updatedAt: nowIso(),
  });
  integrations.set(
    integrations.get().map((item) => (item.id === row.id ? next : item)),
  );
  return { data: next };
});

// ------------------------------------------------------------ config bundle

const bundle = createMockStore<ConfigBundle>(() => fixtures.configBundle);

function withSection(
  current: ConfigBundle,
  section: ConfigSection,
  value: unknown,
): ConfigBundle {
  return configBundleSchema.parse({
    ...current,
    sections: { ...current.sections, [section]: value },
  });
}

// ------------------------------------------------------------------- themes

const themes = createMockStore<TenantTheme[]>(() => [...fixtures.themes]);

registerMock(orgEndpoints.listThemes, ({ scenario }) => ({
  data:
    scenario === "empty"
      ? []
      : [...themes.get()].sort((a, b) => b.version - a.version),
}));

registerMock(orgEndpoints.checkTheme, ({ body }) => {
  const check = checkThemeTokens(body.tokens);
  const known = new Set<string>(COLOR_TOKENS);
  return {
    data: {
      ok: check.ok,
      // The wire schema lists base tokens only; derived-token failures (tint
      // ramp) still make `ok` false but are not enumerated here (see report).
      failures: check.failures.filter(
        (failure) => known.has(failure.fg) && known.has(failure.bg),
      ) as unknown as z.infer<typeof themeCheckResultSchema>["failures"],
      invalid: check.invalid,
    },
  };
});

registerMock(orgEndpoints.createThemeDraft, ({ body }) => {
  const version =
    Math.max(0, ...themes.get().map((theme) => theme.version)) + 1;
  const draft = tenantThemeSchema.parse({
    id: newId(),
    tenantId: fixtures.tenant.id,
    brandId: body.brandId,
    version,
    tokens: body.tokens,
    logoMediaId: body.logoMediaId,
    fontFamily: body.fontFamily,
    corners: body.corners,
    contrastCheckPassed: checkThemeTokens(body.tokens).ok,
    status: "draft",
    createdBy: actorId,
    createdAt: nowIso(),
    activatedAt: null,
  });
  themes.set([...themes.get(), draft]);
  return { data: draft };
});

registerMock(orgEndpoints.activateTheme, ({ params }) => {
  try {
    const next = activateTheme(themes.get(), params.themeId, nowIso());
    themes.set(next);
    const active = next.find((theme) => theme.id === params.themeId)!;
    bundle.set(
      withSection(bundle.get(), "theme", {
        version: 1,
        tokens: active.tokens,
        fontFamily: active.fontFamily,
        corners: active.corners,
      }),
    );
    return { data: active };
  } catch (error) {
    if (error instanceof PlatformError)
      throw new ApiError(error.status, error.code, error.message);
    throw error;
  }
});

// ------------------------------------------------------- export / import

registerMock(orgEndpoints.exportConfig, ({ body }) => {
  const current = bundle.get();
  const wanted = body.sections;
  const sections = wanted
    ? Object.fromEntries(
        Object.entries(current.sections).filter(([key]) =>
          (wanted as string[]).includes(key),
        ),
      )
    : current.sections;
  return {
    data: configBundleSchema.parse({
      ...current,
      exportedAt: nowIso(),
      sections,
    }),
  };
});

registerMock(importOrgConfig, ({ body }) => {
  if (body.bundle === undefined)
    throw new ApiError(
      422,
      "CONFIG_BUNDLE_INVALID",
      "Berkas konfigurasi tidak valid.",
    );
  const parsed = parseConfigBundle(body.bundle);
  if (!parsed.ok)
    throw new ApiError(
      422,
      "CONFIG_BUNDLE_INVALID",
      "Berkas konfigurasi tidak valid.",
    );
  const incoming = parsed.bundle;
  const present = Object.keys(incoming.sections) as ConfigSection[];
  const applied = body.sections
    ? present.filter((section) => body.sections!.includes(section))
    : present;
  let next = bundle.get();
  for (const section of applied)
    next = withSection(next, section, incoming.sections[section]);
  bundle.set(next);
  return {
    data: configImportSchema.parse({
      id: newId(),
      tenantId: fixtures.tenant.id,
      templateId: null,
      status: "applied",
      appliedSections: applied,
      errors: [],
      warnings: [],
      startedBy: actorId,
      startedAt: nowIso(),
      finishedAt: nowIso(),
    }),
  };
});

// ----------------------------------------------------------- text overrides

const overrides = createMockStore<TextOverrideRecord[]>(() =>
  cafeLegendTextFixtures.overrides.map((row) =>
    textOverrideRecordSchema.parse({ ...row, version: 1 }),
  ),
);

registerMock(textOverrideEndpoints.listTextOverrides, ({ scenario, query }) => {
  const rows = scenario === "empty" ? [] : overrides.get();
  return {
    data: query.locale
      ? rows.filter((row) => row.locale === query.locale)
      : rows,
  };
});

registerMock(textOverrideEndpoints.putTextOverride, ({ body }) => {
  const existing = overrides
    .get()
    .find((row) => row.locale === body.locale && row.key === body.key);
  const row = textOverrideRecordSchema.parse({
    id: existing?.id ?? newId(),
    tenantId: fixtures.tenant.id,
    locale: body.locale,
    key: body.key,
    value: body.value,
    updatedAt: nowIso(),
    version: (existing?.version ?? 0) + 1,
  });
  overrides.set(
    existing
      ? overrides.get().map((item) => (item.id === row.id ? row : item))
      : [...overrides.get(), row],
  );
  return { data: row };
});

registerMock(deleteTextOverride, ({ params }) => {
  if (!overrides.get().some((row) => row.id === params.overrideId))
    throw new ApiError(404, "NOT_FOUND", "Istilah tidak ditemukan.");
  overrides.set(overrides.get().filter((row) => row.id !== params.overrideId));
});
