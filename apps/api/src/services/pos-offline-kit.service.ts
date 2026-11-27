// O1 offline kit (bead legend-wasr7.5; docs/design/cloud-only-release.md §2;
// contract @starter/shared/pos offline.ts).
//
// The cloud hands the device of an open shift what it needs to keep selling
// while the internet is down: the dine-in and takeaway price lists, the tax and
// service-charge rules, the offline tenders (cash, manual EDC) and the device's
// offline receipt run (`L<n>`, one epoch). Valid 24 hours. Every kit is stored
// (append-only) and names its snapshot, kept once per (outlet, catalogue
// version), so O2 can check synced prices against what the tablet was told.
//
// Who may ask: the shift's own cashier, on the shift's own registered device,
// while the shift is open. The route also requires shift.cash.operate; the
// service checks it again and fails closed.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type {
  OutletId,
  ScopedTenantContext,
  UserId,
} from "@starter/shared/core";
import { CoreError } from "@starter/shared/core";
import {
  OFFLINE_KIT_SERVICE_TYPES,
  OFFLINE_KIT_TTL_MS,
  OFFLINE_TENDER_METHODS,
  PosError,
  posOfflineKitSchema,
  type IssuePosOfflineKitInput,
  type PosOfflineKit,
  type PosOfflineTaxSnapshot,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import {
  posOfflineCatalogSnapshots,
  posOfflineKits,
} from "../db/schema/pos-offline.ts";
import { posShifts } from "../db/schema/pos-shift.ts";
import { withTenant } from "../db/tenant.ts";
import { resolveDeviceOutlet } from "./device-pin.service.ts";
import { getPosCatalog } from "./pos-catalog.service.ts";
import { loadPosTaxConfig } from "./pos-order-pricing.ts";
import { ensureOfflineReceiptRun } from "./pos-receipt.service.ts";
import { isEdgeProcess } from "./pos-edge-outlet.ts";
import { assertOutletPermission } from "./pos-shift-support.ts";

export type OfflineKitCaller = { userId: UserId; deviceId: string | null };

const NO_DEVICE = "Bekal offline hanya untuk perangkat kasir terdaftar.";
const CLOUD_ONLY = "Bekal offline hanya diterbitkan server pusat.";
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Stable JSON: object keys sorted, so the same snapshot always hashes to the
 * same catalogue version whatever order the readers built it in.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

export async function issuePosOfflineKit(
  context: ScopedTenantContext,
  caller: OfflineKitCaller,
  outletId: OutletId,
  shiftId: string,
  input: IssuePosOfflineKitInput,
  now = new Date(),
): Promise<PosOfflineKit> {
  // Review O1 P2: the L-run is cloud-issued only; an edge never hands it out.
  if (isEdgeProcess()) throw new CoreError("CONFLICT", CLOUD_ONLY);
  if (caller.deviceId === null) throw new CoreError("FORBIDDEN", NO_DEVICE);
  const deviceId = caller.deviceId;
  const tenantId = context.tenant.tenantId;
  const deviceOutlet = await resolveDeviceOutlet(tenantId, deviceId);
  if (deviceOutlet === null || !sameId(deviceOutlet, outletId))
    throw new CoreError("FORBIDDEN", NO_DEVICE);

  return withTenant(db, context, async (tx) => {
    await assertOutletPermission(
      tx,
      context,
      caller.userId,
      outletId,
      "shift.cash.operate",
    );
    const [shift] = await tx
      .select({
        id: posShifts.id,
        deviceId: posShifts.deviceId,
        cashierId: posShifts.cashierId,
        status: posShifts.status,
      })
      .from(posShifts)
      .where(
        and(
          eq(posShifts.tenantId, tenantId),
          eq(posShifts.outletId, outletId),
          eq(posShifts.id, shiftId),
        ),
      )
      .for("share");
    // Not open, or not this cashier's shift on this device: one answer, so a
    // caller learns nothing about other shifts.
    if (
      !shift ||
      shift.status !== "open" ||
      !sameId(shift.deviceId, deviceId) ||
      !sameId(shift.cashierId, caller.userId)
    )
      throw new PosError("SHIFT_NOT_OPEN");

    // The priced snapshot, read at `now` (no images: the tablet sells
    // offline). Review O1 P3 1: only once the caller and the shift passed.
    const [dineIn, takeaway] = await Promise.all(
      OFFLINE_KIT_SERVICE_TYPES.map((serviceType) =>
        getPosCatalog(context, outletId, { channel: "pos", serviceType }, now),
      ),
    );
    const catalogs = { dine_in: dineIn!, takeaway: takeaway! };

    const taxConfig = await loadPosTaxConfig(tx, context, outletId);
    const tax: PosOfflineTaxSnapshot = {
      taxRules: taxConfig.taxRules,
      settings: taxConfig.settings,
      serviceChargeRules: taxConfig.serviceChargeRules,
    };
    const snapshot = { catalogs, tax };
    // Content version: the catalogue read stamps (`updatedAt`) are left out,
    // so the same prices and rules always give the same version.
    const priced = {
      catalogs: {
        dine_in: { ...catalogs.dine_in, updatedAt: null },
        takeaway: { ...catalogs.takeaway, updatedAt: null },
      },
      tax,
    };
    const catalogVersion = createHash("sha256")
      .update(canonicalJson(priced))
      .digest("hex");

    // Review O1 P3 2 (legend-wasr7.15): one stored snapshot per (outlet,
    // catalogue version); a kit names it, it does not copy it.
    await tx
      .insert(posOfflineCatalogSnapshots)
      .values({ tenantId, outletId, catalogVersion, snapshot })
      .onConflictDoNothing({
        target: [
          posOfflineCatalogSnapshots.tenantId,
          posOfflineCatalogSnapshots.outletId,
          posOfflineCatalogSnapshots.catalogVersion,
        ],
      });

    const run = await ensureOfflineReceiptRun(
      tx,
      tenantId,
      outletId,
      deviceId,
      input.resumeSequenceId,
    );
    const issuedAt = now;
    const expiresAt = new Date(issuedAt.getTime() + OFFLINE_KIT_TTL_MS);
    const [row] = await tx
      .insert(posOfflineKits)
      .values({
        tenantId,
        outletId,
        deviceId,
        shiftId: shift.id,
        sequenceId: run.sequenceId,
        issuedBy: caller.userId,
        catalogVersion,
        issuedAt,
        expiresAt,
      })
      .returning({ id: posOfflineKits.id });
    if (!row) throw new Error("Offline kit insert returned no row");

    return posOfflineKitSchema.parse({
      kitId: row.id,
      outletId,
      deviceId,
      shiftId: shift.id,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      catalogVersion,
      catalogs,
      tax,
      tenders: [...OFFLINE_TENDER_METHODS],
      receiptRun: {
        sequenceId: run.sequenceId,
        prefix: run.prefix,
        lastNumber: run.lastNumber,
        startedAt: run.startedAt.toISOString(),
      },
    });
  });
}
