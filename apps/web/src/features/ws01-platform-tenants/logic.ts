// Pure rules of the Panel Platform tenant screens (bead legend-tno; PRD v1.7
// §3 F1 "Layar Platform", §3 F4 "Super Admin" + "Hierarki Organisasi", §4
// Alur R "Super Admin Menambah Tenant Baru", TEN-06). No framework imports, so
// the root contract test can load this file with plain Node ESM.
//
// Validation always runs the contract's own zod schemas (picked per wizard
// step); the catalog text for a failed field is chosen here by field key.
import {
  COST_CAPS,
  COUNT_QUOTAS,
  WEEKDAYS,
  canTransitionTenant,
  createBrandInputSchema,
  createLegalEntityInputSchema,
  createOutletInputSchema,
  createTenantInputSchema,
  setTenantStatusInputSchema,
} from "@starter/shared/platform";
import type {
  CreateBrandInput,
  CreateLegalEntityInput,
  CreateOutletInput,
  CreateTenantInput,
  PlatformPackage,
  TenantStatus,
} from "@starter/shared/platform";
import type { MessageKey } from "@starter/shared/i18n";

// ------------------------------------------------------------------ list

export const TENANT_PAGE_SIZE = 10;
export const ALL_STATUSES = "all";

export type StatusFilter = TenantStatus | typeof ALL_STATUSES;

/** Query for GET /api/platform/tenants: empty filters are left out. */
export function buildListQuery(input: {
  status: StatusFilter;
  search: string;
  cursor?: string;
}) {
  const q = input.search.trim();
  return {
    limit: TENANT_PAGE_SIZE,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.status !== ALL_STATUSES ? { status: input.status } : {}),
    ...(q ? { q } : {}),
  };
}

export type StatusTone = "success" | "warning" | "neutral";

export const TENANT_STATUS_TONE: Record<TenantStatus, StatusTone> = {
  active: "success",
  suspended: "warning",
  archived: "neutral",
};

export const TENANT_STATUS_LABEL: Record<TenantStatus, MessageKey> = {
  active: "platformTenants.status.active" as MessageKey,
  suspended: "platformTenants.status.suspended" as MessageKey,
  archived: "platformTenants.status.archived" as MessageKey,
};

// ------------------------------------------------------- status changes

/**
 * Status changes the detail screen offers: "Aktifkan" and "Nonaktifkan"
 * (PRD §3 F4: Super Admin "membuat dan menonaktifkan tenant"). Deactivating is
 * `suspended` (reversible). Archiving is final and has no button here; the
 * contract's transition table decides what is allowed.
 */
export function statusActions(current: TenantStatus): TenantStatus[] {
  return (["active", "suspended"] as const).filter(
    (target) => target !== current && canTransitionTenant(current, target),
  );
}

/** Same rule as the contract: 10-500 characters after trimming. */
export function validateReason(reason: string): boolean {
  return setTenantStatusInputSchema.shape.reason.safeParse(reason).success;
}

// ----------------------------------------------------------------- usage

/** Whole percent of a quota or cap used, clamped to 0-100 (integer maths). */
export function usagePercent(used: number, limit: number): number {
  if (limit <= 0) return used > 0 ? 100 : 0;
  return Math.min(100, Math.floor((used * 100) / limit));
}

/** R18: alert at 80%, stop at 100%. */
export function usageTone(
  used: number,
  limit: number,
): "success" | "warning" | "danger" {
  if (limit <= 0 || used >= limit) return "danger";
  return usagePercent(used, limit) >= 80 ? "warning" : "success";
}

export const QUOTA_LABEL: Record<(typeof COUNT_QUOTAS)[number], MessageKey> = {
  outlets: "platformTenants.usage.quota.outlets" as MessageKey,
  active_employees:
    "platformTenants.usage.quota.active_employees" as MessageKey,
  devices: "platformTenants.usage.quota.devices" as MessageKey,
  ai_requests: "platformTenants.usage.quota.ai_requests" as MessageKey,
};

export const CAP_LABEL: Record<(typeof COST_CAPS)[number], MessageKey> = {
  whatsapp: "platformTenants.usage.cap.whatsapp" as MessageKey,
  ai: "platformTenants.usage.cap.ai" as MessageKey,
  email: "platformTenants.usage.cap.email" as MessageKey,
};

// ---------------------------------------------------------------- wizard

export const WIZARD_STEPS = [
  "tenant",
  "brand",
  "outlet",
  "legal",
  "admin",
  "review",
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export type WizardDraft = {
  tenant: {
    name: string;
    slug: string;
    slugTouched: boolean;
    plan: string;
    deploymentMode: "dedicated" | "shared";
  };
  brand: { name: string; slug: string; slugTouched: boolean };
  outlet: { code: string; name: string; address: string };
  legal: { name: string; npwp: string; isPkp: boolean; address: string };
  admin: { name: string; whatsapp: string; email: string };
};

export const EMPTY_DRAFT: WizardDraft = {
  tenant: {
    name: "",
    slug: "",
    slugTouched: false,
    plan: "",
    // PRD v1.7 §2 "Mode deployment" / D5: tenants run on the shared
    // deployment; dedicated is the exception Super Admin opts into.
    deploymentMode: "shared",
  },
  brand: { name: "", slug: "", slugTouched: false },
  outlet: { code: "", name: "", address: "" },
  legal: { name: "", npwp: "", isPkp: false, address: "" },
  admin: { name: "", whatsapp: "", email: "" },
};

/** "Kopi Senja & Co" -> "kopi-senja-co" (matches the contract's slug pattern). */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 59)
    .replace(/-+$/g, "");
}

/** Outlet code is upper case, A-Z 0-9 and "-" only. */
export function normalizeOutletCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/\s+/g, "-")
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 20);
}

/** "0812-3456-7890", "+62 812…" and "62812…" all become "62812…". */
export function normalizeWhatsapp(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.startsWith("62")) return digits;
  if (digits.startsWith("0")) return `62${digits.slice(1)}`;
  if (digits.startsWith("8")) return `62${digits}`;
  return digits;
}

export type FieldKey =
  | "tenantName"
  | "slug"
  | "plan"
  | "brandName"
  | "brandSlug"
  | "outletCode"
  | "outletName"
  | "outletAddress"
  | "legalName"
  | "npwp"
  | "legalAddress"
  | "adminName"
  | "whatsapp"
  | "email";

export type FieldErrors = Partial<Record<FieldKey, MessageKey>>;

/**
 * Slugs that would collide with platform hostnames once used as
 * `<slug>.<platform domain>` (domains.ts `platformSubdomain`). Invented list
 * (not in the PRD or contract): the API must enforce its own; this only
 * stops the obvious ones before a round trip.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "www",
  "api",
  "app",
  "admin",
  "platform",
  "auth",
  "login",
  "mail",
  "smtp",
  "static",
  "cdn",
  "assets",
  "media",
  "status",
  "help",
  "support",
  "docs",
  "mcp",
  "edge",
]);

export const isReservedSlug = (slug: string) => RESERVED_SLUGS.has(slug);

const errorKey = (field: FieldKey) =>
  `platformTenants.errors.${field}` as MessageKey;

type Issues = { issues: readonly { path: PropertyKey[] }[] };

function collect(
  errors: FieldErrors,
  result: { success: boolean; error?: Issues },
  mapping: Record<string, FieldKey>,
) {
  if (result.success || !result.error) return;
  for (const issue of result.error.issues) {
    const field = mapping[String(issue.path[0] ?? "")];
    if (field) errors[field] ??= errorKey(field);
  }
}

const tenantFields = createTenantInputSchema.pick({
  slug: true,
  name: true,
  plan: true,
});
const brandFields = createBrandInputSchema.pick({ slug: true, name: true });
const outletFields = createOutletInputSchema.pick({
  code: true,
  name: true,
  address: true,
});
const legalFields = createLegalEntityInputSchema.pick({
  name: true,
  npwp: true,
  address: true,
});
const adminFields = createTenantInputSchema.shape.firstAdmin;

/** The package keys offered by GET /api/platform/packages that may be assigned. */
export function assignablePackages(
  packages: readonly PlatformPackage[],
): PlatformPackage[] {
  return packages.filter((pkg) => pkg.status === "active");
}

/**
 * Field errors for one step (empty object = the step may continue). Uses the
 * contract's zod schemas; the text comes from the catalog by field key.
 */
export function validateStep(
  step: WizardStep,
  draft: WizardDraft,
  packages: readonly PlatformPackage[] = [],
): FieldErrors {
  const errors: FieldErrors = {};
  switch (step) {
    case "tenant": {
      collect(
        errors,
        tenantFields.safeParse({
          slug: draft.tenant.slug,
          name: draft.tenant.name,
          plan: draft.tenant.plan,
        }),
        { slug: "slug", name: "tenantName", plan: "plan" },
      );
      if (!errors.slug && isReservedSlug(draft.tenant.slug))
        errors.slug = "platformTenants.errors.slugReserved" as MessageKey;
      if (
        !errors.plan &&
        !assignablePackages(packages).some(
          (pkg) => pkg.key === draft.tenant.plan,
        )
      )
        errors.plan = errorKey("plan");
      break;
    }
    case "brand":
      collect(
        errors,
        brandFields.safeParse({
          slug: draft.brand.slug,
          name: draft.brand.name,
        }),
        { slug: "brandSlug", name: "brandName" },
      );
      if (!errors.brandSlug && isReservedSlug(draft.brand.slug))
        errors.brandSlug = "platformTenants.errors.slugReserved" as MessageKey;
      break;
    case "outlet":
      collect(
        errors,
        outletFields.safeParse({
          code: draft.outlet.code,
          name: draft.outlet.name,
          address: draft.outlet.address,
        }),
        { code: "outletCode", name: "outletName", address: "outletAddress" },
      );
      break;
    case "legal": {
      const npwp = draft.legal.npwp.trim();
      collect(
        errors,
        legalFields.safeParse({
          name: draft.legal.name,
          npwp: npwp === "" ? null : npwp,
          address: draft.legal.address.trim() || null,
        }),
        { name: "legalName", npwp: "npwp", address: "legalAddress" },
      );
      // A PKP entity issues tax invoices, so it cannot lack an NPWP.
      if (draft.legal.isPkp && npwp === "") errors.npwp ??= errorKey("npwp");
      break;
    }
    case "admin":
      collect(
        errors,
        adminFields.safeParse({
          name: draft.admin.name,
          whatsapp: normalizeWhatsapp(draft.admin.whatsapp),
          email: draft.admin.email.trim() || null,
        }),
        { name: "adminName", whatsapp: "whatsapp", email: "email" },
      );
      break;
    case "review":
      break;
  }
  return errors;
}

/** First step (in order) that has an error; the review step is blocked until none. */
export function firstInvalidStep(
  draft: WizardDraft,
  packages: readonly PlatformPackage[],
): WizardStep | null {
  for (const step of WIZARD_STEPS)
    if (Object.keys(validateStep(step, draft, packages)).length > 0)
      return step;
  return null;
}

// -------------------------------------------------------------- payloads

/**
 * The package supplies the starting modules and quotas (PRD §3 F4 "Paket"); no
 * integration provider is switched on until Super Admin enables one.
 */
export function buildTenantInput(
  draft: WizardDraft,
  pkg: PlatformPackage,
): CreateTenantInput {
  return createTenantInputSchema.parse({
    slug: draft.tenant.slug,
    name: draft.tenant.name,
    plan: pkg.key,
    deploymentMode: draft.tenant.deploymentMode,
    featureFlags: { modules: [...pkg.modules], integrationProviders: [] },
    limits: { ...pkg.defaultLimits },
    firstAdmin: {
      name: draft.admin.name,
      whatsapp: normalizeWhatsapp(draft.admin.whatsapp),
      email: draft.admin.email.trim() || null,
    },
  });
}

export function buildLegalEntityInput(
  draft: WizardDraft,
): CreateLegalEntityInput {
  const npwp = draft.legal.npwp.trim();
  return createLegalEntityInputSchema.parse({
    name: draft.legal.name,
    npwp: npwp === "" ? null : npwp,
    isPkp: draft.legal.isPkp,
    address: draft.legal.address.trim() || null,
  });
}

export function buildBrandInput(draft: WizardDraft): CreateBrandInput {
  return createBrandInputSchema.parse({
    slug: draft.brand.slug,
    name: draft.brand.name,
    logoMediaId: null,
  });
}

/** Opening hours are a starting point (08:00-22:00); the tenant admin edits them. */
export const DEFAULT_OPENING_HOURS = Object.fromEntries(
  WEEKDAYS.map((day) => [day, { opens: "08:00", closes: "22:00" }]),
) as Record<(typeof WEEKDAYS)[number], { opens: string; closes: string }>;

export function buildOutletInput(
  draft: WizardDraft,
  ids: { brandId: string; legalEntityId: string },
): CreateOutletInput {
  return createOutletInputSchema.parse({
    brandId: ids.brandId,
    legalEntityId: ids.legalEntityId,
    code: draft.outlet.code,
    name: draft.outlet.name,
    address: draft.outlet.address,
    openingHours: DEFAULT_OPENING_HOURS,
  });
}

// ---------------------------------------------------------------- display

/** NPWP never leaves the server in full; show the last four digits only. */
export function maskNpwp(last4: string | null): string | null {
  return last4 ? `••••${last4}` : null;
}

/**
 * TEN-04: the first admin's contact is personal data. Platform screens show
 * only enough to recognise it: "62••••••7890" / "s•••@kopisenja.id".
 */
export function maskWhatsapp(input: string): string {
  const digits = normalizeWhatsapp(input);
  if (digits.length < 8) return "••••••";
  return `${digits.slice(0, 2)}••••••${digits.slice(-4)}`;
}

export function maskEmail(input: string | null): string | null {
  const email = input?.trim();
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

/** Rows from the server plus rows just created in this session, by id. */
export function mergeById<T extends { id: string }>(
  fromServer: readonly T[],
  created: readonly T[],
): T[] {
  const seen = new Set(fromServer.map((row) => row.id));
  return [...fromServer, ...created.filter((row) => !seen.has(row.id))];
}
