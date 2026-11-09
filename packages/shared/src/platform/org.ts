// Organisation hierarchy (PRD v1.7 §3 F4 "Hierarki Organisasi", §6 A
// `tenants`, `brands`, `outlets`, `legal_entities`, `platform_admins`,
// `regions`; user flow R "Super Admin Menambah Tenant Baru").
//
// Tenant (company on the platform) -> Brand (e.g. Cafe Legend) -> Outlet
// (physical site). A tenant may own several brands, outlets and legal
// entities (each with its own NPWP and PKP status); every outlet names the
// legal entity that books its revenue. TEN-06: all of it is data created from
// the panel, never code or a deploy.
//
// The *Ref schemas in core/fixtures.ts stay the minimal embedded references;
// the full DTOs below are their supersets (same field names and formats).

import {
  brandIdSchema,
  clientInputSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  timeOfDaySchema,
  timeZoneSchema,
  userIdSchema,
  uuidSchema,
  z,
  DEFAULT_TIME_ZONE,
  DEFAULT_BUSINESS_DAY_CUTOFF,
  businessDayCutoffSchema,
} from "../core/index.ts";
import { bankAccountIdSchema } from "../accounting/ids.ts";
import {
  legalEntityIdSchema,
  platformAdminIdSchema,
  regionIdSchema,
  tenantThemeIdSchema,
} from "./ids.ts";
import { featureFlagsSchema, packageKeySchema } from "./modules.ts";
import { tenantLimitsSchema } from "./limits.ts";

/** Same pattern as core `tenantRefSchema.slug`; also the default subdomain. */
export const slugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/, "Use a-z, 0-9 and -");
const name150 = z.string().trim().min(1).max(150);
const reasonSchema = z.string().trim().min(10).max(500);

// ---------------------------------------------------------------- tenants

export const TENANT_STATUSES = ["active", "suspended", "archived"] as const;
export const tenantStatusSchema = z.enum(TENANT_STATUSES);
export type TenantStatus = z.infer<typeof tenantStatusSchema>;

export const deploymentModeSchema = z.enum(["dedicated", "shared"]);
export type DeploymentMode = z.infer<typeof deploymentModeSchema>;

/** `tenants` (global). */
export const tenantSchema = z.strictObject({
  id: tenantIdSchema,
  slug: slugSchema,
  name: name150,
  plan: packageKeySchema,
  status: tenantStatusSchema,
  deploymentMode: deploymentModeSchema,
  featureFlags: featureFlagsSchema,
  limits: tenantLimitsSchema,
  createdBy: userIdSchema,
  createdAt: isoDateTimeSchema,
});
export type Tenant = z.infer<typeof tenantSchema>;

/**
 * Super Admin "membuat dan menonaktifkan tenant". Suspension is reversible.
 * Archiving is final through this map (data kept); the only way back is the
 * platform restore within {@link RESTORE_WINDOW_DAYS} days (Q40, see
 * `canRestoreFrom`), which returns the tenant to its status before archiving.
 */
const tenantTransitions: Record<TenantStatus, readonly TenantStatus[]> = {
  active: ["suspended", "archived"],
  suspended: ["active", "archived"],
  archived: [],
};
export function canTransitionTenant(
  from: TenantStatus,
  to: TenantStatus,
): boolean {
  return tenantTransitions[from].includes(to);
}

/**
 * Worker contract (apps/api/src/worker-main.ts): the queue role reads only
 * `app.active_tenant_registry`, a view with a single `id uuid` column listing
 * tenants whose status is `active`. Suspended or archived tenants drop out, so
 * their outbox is neither relayed nor delivered. The migration bead
 * (legend-ov8) creates it from this definition.
 */
export const ACTIVE_TENANT_REGISTRY = {
  view: "app.active_tenant_registry",
  columns: ["id"],
  sourceTable: "tenants",
  activeStatus: "active",
  definitionSql:
    "CREATE OR REPLACE VIEW app.active_tenant_registry AS SELECT id FROM public.tenants WHERE status = 'active'",
} as const satisfies {
  view: string;
  columns: readonly string[];
  sourceTable: string;
  activeStatus: TenantStatus;
  definitionSql: string;
};
export const activeTenantRegistryRowSchema = z.strictObject({
  id: tenantIdSchema,
});
export type ActiveTenantRegistryRow = z.infer<
  typeof activeTenantRegistryRowSchema
>;
/** Same predicate as the view: only active tenants are served or worked. */
export function isTenantActive(tenant: Pick<Tenant, "status">): boolean {
  return tenant.status === ACTIVE_TENANT_REGISTRY.activeStatus;
}

const whatsappNumber = z
  .string()
  .regex(/^628\d{7,12}$/, "WhatsApp number as digits, e.g. 62812…");

/** Panel Platform: create tenant + appoint first admin (flow R steps 2-3).
 * A tenant is created `active`; its domains, brands and outlets follow. */
export const createTenantInputSchema = clientInputSchema({
  slug: slugSchema,
  name: name150,
  plan: packageKeySchema,
  deploymentMode: deploymentModeSchema,
  featureFlags: featureFlagsSchema,
  limits: tenantLimitsSchema,
  firstAdmin: z.strictObject({
    name: name150,
    whatsapp: whatsappNumber,
    email: z.email().max(254).nullable(),
  }),
});
export type CreateTenantInput = z.infer<typeof createTenantInputSchema>;

export const setTenantStatusInputSchema = clientInputSchema({
  status: tenantStatusSchema,
  reason: reasonSchema,
});
export type SetTenantStatusInput = z.infer<typeof setTenantStatusInputSchema>;
export const setTenantPackageInputSchema = clientInputSchema({
  plan: packageKeySchema,
  featureFlags: featureFlagsSchema,
  limits: tenantLimitsSchema,
  reason: reasonSchema,
});
export type SetTenantPackageInput = z.infer<typeof setTenantPackageInputSchema>;

// ---------------------------------------------------------------- brands

/** `brands` (T). `themeId` is the active Tenant Theme; `primaryHostname`
 * the brand's canonical domain (both nullable until set up). */
export const brandSchema = z.strictObject({
  id: brandIdSchema,
  tenantId: tenantIdSchema,
  slug: slugSchema,
  name: name150,
  logoMediaId: uuidSchema.nullable(),
  themeId: tenantThemeIdSchema.nullable(),
  primaryHostname: z.string().max(253).nullable(),
  createdAt: isoDateTimeSchema,
});
export type Brand = z.infer<typeof brandSchema>;

export const createBrandInputSchema = clientInputSchema({
  slug: slugSchema,
  name: name150,
  logoMediaId: uuidSchema.nullable().default(null),
});
export type CreateBrandInput = z.infer<typeof createBrandInputSchema>;
export const updateBrandInputSchema = clientInputSchema({
  name: name150.optional(),
  logoMediaId: uuidSchema.nullable().optional(),
});
export type UpdateBrandInput = z.infer<typeof updateBrandInputSchema>;

// ---------------------------------------------------------- legal entities

/** NPWP: 15 digits (legacy) or 16 digits (NIK-based, since 2024). Input may
 * use dots/dashes/spaces; they are stripped. */
export const npwpInputSchema = z
  .string()
  .transform((value) => value.replace(/[.\-\s]/g, ""))
  .pipe(z.string().regex(/^(\d{15}|\d{16})$/, "NPWP has 15 or 16 digits"));

/** `legal_entities` (T). `npwp_encrypted` never leaves the server: reads
 * carry only the last four digits. Bank accounts are the accounting
 * contract's `bank_accounts` rows keyed by this legal entity. */
export const legalEntitySchema = z.strictObject({
  id: legalEntityIdSchema,
  tenantId: tenantIdSchema,
  name: name150,
  npwpLast4: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  isPkp: z.boolean(),
  address: z.string().trim().min(1).max(500).nullable(),
  bankAccountIds: z.array(bankAccountIdSchema),
  createdAt: isoDateTimeSchema,
});
export type LegalEntity = z.infer<typeof legalEntitySchema>;

export const createLegalEntityInputSchema = clientInputSchema({
  name: name150,
  npwp: npwpInputSchema.nullable(),
  isPkp: z.boolean(),
  address: z.string().trim().min(1).max(500).nullable(),
});
export type CreateLegalEntityInput = z.infer<
  typeof createLegalEntityInputSchema
>;
export const updateLegalEntityInputSchema = clientInputSchema({
  name: name150.optional(),
  npwp: npwpInputSchema.nullable().optional(),
  isPkp: z.boolean().optional(),
  address: z.string().trim().min(1).max(500).nullable().optional(),
});
export type UpdateLegalEntityInput = z.infer<
  typeof updateLegalEntityInputSchema
>;

/** Last four NPWP digits for display; never more. */
export function npwpLast4(npwp: string): string {
  const digits = npwpInputSchema.parse(npwp);
  return digits.slice(-4);
}

// ---------------------------------------------------------------- outlets

export const OUTLET_STATUSES = ["preopening", "active", "closed"] as const;
export const outletStatusSchema = z.enum(OUTLET_STATUSES);
export type OutletStatus = z.infer<typeof outletStatusSchema>;

const outletTransitions: Record<OutletStatus, readonly OutletStatus[]> = {
  preopening: ["active", "closed"],
  active: ["closed"],
  closed: [],
};
/** Closing is final through this map (history stays); a reopened site is a
 * new outlet. Only the platform restore within {@link RESTORE_WINDOW_DAYS}
 * days (Q40) returns a closed outlet to its status before closing. */
export function canTransitionOutlet(
  from: OutletStatus,
  to: OutletStatus,
): boolean {
  return outletTransitions[from].includes(to);
}

/** Point + radius for attendance (PRD §6 A `outlets.geofence`). */
export const geofenceSchema = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMeters: z.number().int().min(10).max(2_000),
});
export type Geofence = z.infer<typeof geofenceSchema>;

export const WEEKDAYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;
const dayHours = z
  .strictObject({ opens: timeOfDaySchema, closes: timeOfDaySchema })
  .refine((hours) => hours.opens !== hours.closes, {
    message: "Opening and closing time must differ",
  });
/** Per weekday: null = closed. `closes` earlier than `opens` = past midnight. */
export const openingHoursSchema = z.strictObject(
  Object.fromEntries(WEEKDAYS.map((day) => [day, dayHours.nullable()])) as {
    [Day in (typeof WEEKDAYS)[number]]: z.ZodNullable<typeof dayHours>;
  },
);
export type OpeningHours = z.infer<typeof openingHoursSchema>;

/** `outlets` (T). Superset of core `outletRefSchema`. */
export const outletSchema = z.strictObject({
  id: outletIdSchema,
  tenantId: tenantIdSchema,
  brandId: brandIdSchema,
  legalEntityId: legalEntityIdSchema,
  code: z
    .string()
    .regex(/^[A-Z0-9][A-Z0-9-]{0,19}$/, "Outlet code: A-Z, 0-9, -"),
  name: name150,
  address: z.string().trim().min(1).max(500),
  regionId: regionIdSchema.nullable(),
  geofence: geofenceSchema.nullable(),
  timeZone: timeZoneSchema,
  /** Owner Q39: when the business day starts ("HH:mm", default 04:00). */
  businessDayCutoff: businessDayCutoffSchema,
  openingHours: openingHoursSchema,
  edgeNodeId: uuidSchema.nullable(),
  status: outletStatusSchema,
  createdAt: isoDateTimeSchema,
});
export type Outlet = z.infer<typeof outletSchema>;

export const createOutletInputSchema = clientInputSchema({
  brandId: brandIdSchema,
  legalEntityId: legalEntityIdSchema,
  code: outletSchema.shape.code,
  name: name150,
  address: z.string().trim().min(1).max(500),
  regionId: regionIdSchema.nullable().default(null),
  geofence: geofenceSchema.nullable().default(null),
  timeZone: timeZoneSchema.default(DEFAULT_TIME_ZONE),
  businessDayCutoff: businessDayCutoffSchema.default(
    DEFAULT_BUSINESS_DAY_CUTOFF,
  ),
  openingHours: openingHoursSchema,
});
export type CreateOutletInput = z.infer<typeof createOutletInputSchema>;
export const updateOutletInputSchema = clientInputSchema({
  name: name150.optional(),
  legalEntityId: legalEntityIdSchema.optional(),
  address: z.string().trim().min(1).max(500).optional(),
  regionId: regionIdSchema.nullable().optional(),
  geofence: geofenceSchema.nullable().optional(),
  businessDayCutoff: businessDayCutoffSchema.optional(),
  openingHours: openingHoursSchema.optional(),
});
export type UpdateOutletInput = z.infer<typeof updateOutletInputSchema>;
export const setOutletStatusInputSchema = clientInputSchema({
  status: outletStatusSchema,
  reason: reasonSchema,
});
export type SetOutletStatusInput = z.infer<typeof setOutletStatusInputSchema>;

// ------------------------------------------------ restore window (Q40)

/**
 * Founder Q40 (legend-umzos): a Super Admin may restore an archived tenant or
 * a closed outlet to its previous status within 30 days of the transition;
 * after that the status is final. The transition time and previous status are
 * recorded on the row (`tenants.archived_at` / `status_before_archive`,
 * `outlets.closed_at` / `status_before_close`). A row archived or closed
 * before they were recorded cannot prove it is inside the window, so it is
 * final (`RESTORE_NOT_AVAILABLE`).
 */
export const RESTORE_WINDOW_DAYS = 30;
export const RESTORE_WINDOW_MS = RESTORE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Last instant a restore is allowed for a transition at `transitionAt`. */
export function restoreDeadline(transitionAt: Date): Date {
  return new Date(transitionAt.getTime() + RESTORE_WINDOW_MS);
}

export type RestoreCheck =
  | { ok: true; deadline: Date }
  | { ok: false; code: "RESTORE_NOT_AVAILABLE" | "RESTORE_WINDOW_EXPIRED" };

/**
 * Whether a row in a final status may be restored at `now`. `transitionAt` or
 * `previousStatus` missing (legacy rows) means final. The deadline is
 * inclusive: exactly 30 days after the transition still restores.
 */
export function canRestoreFrom(
  transitionAt: Date | null,
  previousStatus: string | null,
  now: Date,
): RestoreCheck {
  if (transitionAt === null || previousStatus === null)
    return { ok: false, code: "RESTORE_NOT_AVAILABLE" };
  const deadline = restoreDeadline(transitionAt);
  if (now.getTime() > deadline.getTime())
    return { ok: false, code: "RESTORE_WINDOW_EXPIRED" };
  return { ok: true, deadline };
}

/** Statuses a tenant can be archived from, so the ones a restore returns to. */
export const tenantRestoreStatusSchema = z.enum(["active", "suspended"]);
/** Statuses an outlet can be closed from, so the ones a restore returns to. */
export const outletRestoreStatusSchema = z.enum(["preopening", "active"]);

/** Panel Platform "Pulihkan": reason is required and audited (TEN-04). */
export const restoreTenantInputSchema = clientInputSchema({
  reason: reasonSchema,
});
export type RestoreTenantInput = z.infer<typeof restoreTenantInputSchema>;
export const restoreOutletInputSchema = clientInputSchema({
  reason: reasonSchema,
});
export type RestoreOutletInput = z.infer<typeof restoreOutletInputSchema>;

/** Read model for the panel: is a restore possible, to what, until when.
 * `restorable` is evaluated at read time against the server clock. */
export const tenantRestoreWindowSchema = z.strictObject({
  tenantId: tenantIdSchema,
  status: tenantStatusSchema,
  archivedAt: isoDateTimeSchema.nullable(),
  restoreTo: tenantRestoreStatusSchema.nullable(),
  restorableUntil: isoDateTimeSchema.nullable(),
  restorable: z.boolean(),
});
export type TenantRestoreWindow = z.infer<typeof tenantRestoreWindowSchema>;
export const outletRestoreWindowSchema = z.strictObject({
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  status: outletStatusSchema,
  closedAt: isoDateTimeSchema.nullable(),
  restoreTo: outletRestoreStatusSchema.nullable(),
  restorableUntil: isoDateTimeSchema.nullable(),
  restorable: z.boolean(),
});
export type OutletRestoreWindow = z.infer<typeof outletRestoreWindowSchema>;

// ------------------------------------------------- platform admins, regions

/** `platform_admins` (global): Super Admin and one break-glass account, both
 * MFA-only (PRD §3 F4 Super Admin). */
export const platformAdminSchema = z.strictObject({
  id: platformAdminIdSchema,
  userId: userIdSchema,
  isBreakGlass: z.boolean(),
  grantedAt: isoDateTimeSchema,
  revokedAt: isoDateTimeSchema.nullable(),
});
export type PlatformAdmin = z.infer<typeof platformAdminSchema>;

/** `regions` (global): administrative regions (province, city, district). */
export const regionSchema = z.strictObject({
  id: regionIdSchema,
  code: z.string().regex(/^[0-9.]{2,13}$/),
  name: name150,
  type: z.enum(["province", "regency", "city", "district", "village"]),
  parentId: regionIdSchema.nullable(),
});
export type Region = z.infer<typeof regionSchema>;
