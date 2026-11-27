// Production device -> outlet resolver for staff device pins (bead
// legend-obh5, from legend-dxb; PRD v1.7 §3 F5 "Registri Perangkat", §3 F6
// "Staf — PIN Perangkat": "staf berganti pengguna dengan PIN pribadi 6 digit
// pada perangkat terdaftar"; TEN-02/TEN-03).
//
// `device-pin.service.ts` refuses every device pin verify until a resolver is
// installed with `setDeviceOutletResolver`. The lead registers
// `createDeviceOutletResolver()` at app and worker boot.
//
// Source of truth: the WS-02 device registry (legend-165), contract
// `deviceSchema` in @starter/shared/edge (tenant_id, outlet_id, id, type,
// status, revoked_at). That table does not exist yet, so the default lookup
// probes for it (`to_regclass`) and answers "unknown" while it is absent; a
// lookup error is also "unknown". legend-165 may instead pass its own lookup.
//
// Deliberately NOT used: `stations.printer_device_id`, the EDC terminal's
// `assigned_device_id` and facility lock/panic device ids. Those columns
// point at peripherals (printers, EDC, locks) configured by back-office
// screens, not at registered staff terminals; trusting them would let a
// printer id, or anyone who can edit a station, bind a device to an outlet.
//
// Fail closed. The resolver answers an outlet only when exactly one registry
// row for the device exists in the caller's tenant (under tenant RLS and an
// explicit tenant filter), it is `active` and not revoked, its type is a staff
// terminal that can take a pin, and its outlet exists in the tenant and is not
// closed. Anything else, including a malformed id, answers null.

import {
  deviceStatusSchema,
  deviceTypeSchema,
  type Device,
} from "@starter/shared/edge";
import {
  outletIdSchema,
  tenantIdSchema,
  uuidSchema,
} from "@starter/shared/core";
import { HttpError } from "../lib/http-error.ts";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import type { DeviceOutletResolver } from "./device-pin.service.ts";

/** Staff terminals on which a person types a pin (§3 F6). */
export const PIN_CAPABLE_DEVICE_TYPES = [
  "pos",
  "kds",
  "waiter_phone",
] as const satisfies readonly Device["type"][];

/** One registry row for a device, joined with its outlet's status. */
export type DeviceRegistryEntry = {
  readonly tenantId: string;
  readonly outletId: string;
  readonly type: string;
  readonly status: string;
  readonly revokedAt: Date | string | null;
  /** `outlets.status` of the device's outlet; null when the outlet is unknown. */
  readonly outletStatus: string | null;
};

/** Every registry row the tenant holds for `deviceId` (normally 0 or 1). */
export type DeviceRegistryLookup = (input: {
  readonly tenantId: string;
  readonly deviceId: string;
}) => Promise<readonly DeviceRegistryEntry[]>;

/**
 * Default lookup over the WS-02 `devices` table (contract `deviceSchema`).
 * Runs inside a tenant-scoped RLS transaction and filters by tenant again.
 * While the table does not exist it returns no rows.
 */
export const devicesTableLookup: DeviceRegistryLookup = async ({
  tenantId,
  deviceId,
}) => {
  const tenant = establishTenantContext({
    tenantId,
    brandId: null,
    source: "device",
  });
  const context = establishScopedTenantContext(tenant, { kind: "tenant" });
  return withTenant(db, context, async (tx) => {
    const probe = await tx.execute(
      sql`SELECT to_regclass('public.devices') IS NOT NULL AS present`,
    );
    if (probe.rows[0]?.present !== true) return [];
    const result = await tx.execute(
      sql`SELECT d.tenant_id, d.outlet_id, d.type, d.status, d.revoked_at, o.status AS outlet_status
          FROM devices d
          LEFT JOIN outlets o ON o.tenant_id = d.tenant_id AND o.id = d.outlet_id
          WHERE d.tenant_id = ${tenantId}::uuid AND d.id = ${deviceId}::uuid
          LIMIT 2`,
    );
    return result.rows.map((row) => ({
      tenantId: String(row.tenant_id),
      outletId: String(row.outlet_id),
      type: String(row.type),
      status: String(row.status),
      revokedAt: (row.revoked_at as Date | string | null) ?? null,
      outletStatus:
        row.outlet_status === null || row.outlet_status === undefined
          ? null
          : String(row.outlet_status),
    }));
  });
};

function isPinTerminal(type: string): boolean {
  const parsed = deviceTypeSchema.safeParse(type);
  return (
    parsed.success &&
    (PIN_CAPABLE_DEVICE_TYPES as readonly string[]).includes(parsed.data)
  );
}

/** The outlet of one registry row, or null when any rule fails. */
function outletOf(entry: DeviceRegistryEntry, tenantId: string): string | null {
  const status = deviceStatusSchema.safeParse(entry.status);
  const outlet = outletIdSchema.safeParse(entry.outletId);
  if (
    entry.tenantId.toLowerCase() !== tenantId.toLowerCase() ||
    !status.success ||
    status.data !== "active" ||
    entry.revokedAt !== null ||
    !isPinTerminal(entry.type) ||
    !outlet.success ||
    entry.outletStatus === null ||
    entry.outletStatus === "closed"
  )
    return null;
  return outlet.data;
}

export type DeviceOutletResolverOptions = {
  /** Registry lookup; defaults to the WS-02 `devices` table. */
  readonly lookup?: DeviceRegistryLookup;
};

/**
 * The production `DeviceOutletResolver`: registered, active, unrevoked staff
 * terminal of this tenant at an open outlet -> that outlet; otherwise null.
 * Never throws (a lookup failure is "unknown device"); its `strict` form
 * throws a 503 on a lookup failure instead (the stuck-sale report).
 */
export function createDeviceOutletResolver(
  options: DeviceOutletResolverOptions = {},
): DeviceOutletResolver {
  const lookup = options.lookup ?? devicesTableLookup;
  const resolve = async (
    input: { readonly tenantId: string; readonly deviceId: string },
    failClosed: boolean,
  ): Promise<string | null> => {
    const tenant = tenantIdSchema.safeParse(input.tenantId);
    const device = uuidSchema.safeParse(input.deviceId);
    if (!tenant.success || !device.success) return null;
    let entries: readonly DeviceRegistryEntry[];
    try {
      entries = await lookup({
        tenantId: tenant.data,
        deviceId: device.data,
      });
    } catch {
      // Never log the device id with the error; the caller answers FORBIDDEN.
      if (failClosed) return null;
      throw new HttpError(
        503,
        "DEVICE_REGISTRY_UNAVAILABLE",
        "Daftar perangkat sedang tidak bisa dibaca. Coba lagi sebentar lagi.",
      );
    }
    // A device id is one registry row. None or several: unknown (fail closed).
    if (entries.length !== 1) return null;
    const [entry] = entries;
    return entry ? outletOf(entry, tenant.data) : null;
  };
  return Object.assign(
    (input: Parameters<typeof resolve>[0]) => resolve(input, true),
    {
      strict: (input: Parameters<typeof resolve>[0]) => resolve(input, false),
    },
  );
}
