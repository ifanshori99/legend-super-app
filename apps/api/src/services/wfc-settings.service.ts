// WFC business settings and the price floor (brief 1270 card W1b, decision 28
// §2). Configuration only: nothing here sells a seat or takes money.
//
// - Propose: a holder of `wfc.policy.manage` proposes every number of a new
//   version. The version id is minted first and becomes the approval's object
//   id; the payload carries every number in camelCase, so the database guard
//   (wfc-seat.custom.sql) can match the row to the very numbers approved. One
//   open proposal per outlet; the date is today or later and never before a
//   version already written; `wfc_seats` is at least the highest quota cell.
// - Apply: only after the whole chain is approved by someone else who also
//   holds `wfc.policy.manage` on the outlet. Runs from the approval.resolved
//   consumer or the apply route, idempotent (the version id is the key). An
//   approval the proposer decided, a payload that does not parse, or a quota
//   that grew past the approved seats writes nothing. Products already sold
//   keep their snapshot; an active product now under the floor is switched off.
// - Floor: `packages/shared/src/wfc/pricing.ts`. Saving a WFC product checks it
//   against every version in force or still to come (422); switching one on
//   also needs a version in force (409 WFC_CONFIG_INCOMPLETE). A day pass is
//   priced as if used through the longest open day of its facility.
// - AI never applies anything here: it may only open the same proposal (W13).
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, lte } from "drizzle-orm";
import { approvalResolvedEvent } from "@starter/shared/identity";
import {
  userIdSchema,
  type ScopedTenantContext,
  type z,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { minutesOfDay, type FacilityDayHours } from "@starter/shared/facility";
import {
  applyWfcSettingsSchema,
  checkWfcProductFloor,
  listWfcSettingsQuerySchema,
  proposeWfcSettingsSchema,
  setWfcProductActiveSchema,
  WFC_MAX_RESERVATION_MINUTES,
  wfcBusinessSettingsSchema,
  wfcHourlyFloors,
  wfcProductSchema,
  wfcSettingsPayloadSchema,
  wfcSettingsProposalSchema,
  type ApplyWfcSettingsInput,
  type ListWfcSettingsInput,
  type ProposeWfcSettingsInput,
  type SetWfcProductActiveInput,
  type WfcAccess,
  type WfcBusinessSettings,
  type WfcProduct,
  type WfcSettingsPayload,
  type WfcSettingsProposal,
} from "@starter/shared/wfc";
import { eqId } from "../db/branded-ids.ts";
import { db } from "../db/index.ts";
import {
  facilities,
  facilityOperatingHoursVersions,
  facilityProducts,
} from "../db/schema/facility.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { wfcBusinessSettings } from "../db/schema/wfc-settings.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { assertConfigFresh, lockConfigRow } from "./facility-config-guard.ts";
import {
  assertFacilityPermission,
  auditFacility,
  notFound,
  type Tx,
} from "./facility-shared.ts";
import {
  openApprovalRequest,
  resolveApprovalChainOutcome,
} from "./platform-approval.service.ts";
import { lockOutletSeats, maxWfcQuota } from "./wfc-seat.service.ts";
import {
  wfcBusinessDate,
  wfcConfigIncomplete,
  type WfcSettingsRow,
} from "./wfc-settings.ts";

export const WFC_APPROVAL_SOURCE_MODULE = "wfc";
export const WFC_SETTINGS_OBJECT_TYPE = "wfc_business_settings";
const WFC_APPROVAL_ACTION = "price_change" as const;
const POLICY_PERMISSION = "wfc.policy.manage" as const;

type ProductRow = typeof facilityProducts.$inferSelect;
type RequestRow = typeof approvalRequests.$inferSelect;

function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new HttpError(400, "VALIDATION_FAILED", "Input tidak valid.");
  return result.data;
}

const priceBelowFloor = (floorIdr: number) =>
  new HttpError(
    422,
    "WFC_PRICE_BELOW_FLOOR",
    `Harga produk WFC di bawah harga terendah (kontribusi minimal Rp${floorIdr.toLocaleString("id-ID")}).`,
  );

// ---- Mappers ----------------------------------------------------------------

function toSettings(row: WfcSettingsRow): WfcBusinessSettings {
  return wfcBusinessSettingsSchema.parse({
    id: row.id,
    outletId: row.outletId,
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    totalSeats: row.totalSeats,
    wfcSeats: row.wfcSeats,
    openHoursPerMonth: row.openHoursPerMonth,
    fixedCostIdr: row.fixedCostIdr,
    targetRevenueIdr: row.targetRevenueIdr,
    targetProfitIdr: row.targetProfitIdr,
    targetOccupancyBp: row.targetOccupancyBp,
    spendPerPersonIdr: row.spendPerPersonIdr,
    cogsBp: row.cogsBp,
    avgStayMinutes: row.avgStayMinutes,
    noShowMinutes: row.noShowMinutes,
  });
}

function toProposal(
  head: RequestRow,
  last: RequestRow,
  applied: boolean,
): WfcSettingsProposal {
  const payload = wfcSettingsPayloadSchema.parse(last.payload);
  return wfcSettingsProposalSchema.parse({
    chainId: head.chainId,
    settingsId: head.objectId,
    status: last.status,
    applied,
    requestedBy: head.requestedBy,
    payload,
    floors: wfcHourlyFloors(payload),
    createdAt: head.createdAt.toISOString(),
  });
}

function toWfcProduct(row: ProductRow): WfcProduct {
  return wfcProductSchema.parse({
    productId: row.id,
    outletId: row.outletId,
    priceIdr: row.priceIdr,
    isActive: row.isActive,
    wfc:
      row.wfcKind === null
        ? null
        : {
            kind: row.wfcKind,
            access: row.wfcAccess,
            seatFeeIdr: row.seatFeeIdr,
            creditIdr: row.creditIdr,
            durationMinutes: row.durationMinutes,
          },
    updatedAt: row.updatedAt.toISOString(),
  });
}

// ---- Settings reads ---------------------------------------------------------

/** Every version that applies today or later: the one in force, then coming ones. */
export async function liveWfcSettings(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  now: Date,
): Promise<{ inForce: WfcSettingsRow | null; all: WfcSettingsRow[] }> {
  const today = await wfcBusinessDate(tx, context, outletId, now);
  const where = and(
    eq(wfcBusinessSettings.tenantId, context.tenant.tenantId),
    eqId(wfcBusinessSettings.outletId, outletId),
  );
  const [inForce] = await tx
    .select()
    .from(wfcBusinessSettings)
    .where(and(where, lte(wfcBusinessSettings.effectiveFrom, today)))
    .orderBy(
      desc(wfcBusinessSettings.effectiveFrom),
      desc(wfcBusinessSettings.version),
    )
    .limit(1);
  const coming = await tx
    .select()
    .from(wfcBusinessSettings)
    .where(and(where, gt(wfcBusinessSettings.effectiveFrom, today)))
    .orderBy(
      asc(wfcBusinessSettings.effectiveFrom),
      asc(wfcBusinessSettings.version),
    );
  return {
    inForce: inForce ?? null,
    all: inForce ? [inForce, ...coming] : coming,
  };
}

// ---- Price floor ------------------------------------------------------------

/** Longest open day (minutes) of a set of facility hours. */
function longestDayMinutes(hours: readonly FacilityDayHours[]): number {
  let longest = 0;
  for (let day = 0; day < 7; day += 1) {
    let open = 0;
    for (const window of hours)
      if (window.daysOfWeek.includes(day))
        open += minutesOfDay(window.closesAt) - minutesOfDay(window.opensAt);
    longest = Math.max(longest, open);
  }
  return Math.min(longest, WFC_MAX_RESERVATION_MINUTES);
}

/**
 * Minutes a day pass may be used: the longest open day of its facility over
 * the hours valid today and every coming version; a full day without hours.
 */
async function dayPassMinutes(
  tx: Tx,
  context: ScopedTenantContext,
  facilityId: string,
  today: string,
): Promise<number> {
  const versions = await tx
    .select({
      effectiveFrom: facilityOperatingHoursVersions.effectiveFrom,
      operatingHours: facilityOperatingHoursVersions.operatingHours,
    })
    .from(facilityOperatingHoursVersions)
    .where(
      and(
        eq(facilityOperatingHoursVersions.tenantId, context.tenant.tenantId),
        eq(facilityOperatingHoursVersions.facilityId, facilityId),
      ),
    )
    .orderBy(desc(facilityOperatingHoursVersions.effectiveFrom));
  const current = versions.findIndex((row) => row.effectiveFrom <= today);
  const live = current === -1 ? versions : versions.slice(0, current + 1);
  const [facility] = await tx
    .select({ operatingHours: facilities.operatingHours })
    .from(facilities)
    .where(
      and(
        eq(facilities.tenantId, context.tenant.tenantId),
        eq(facilities.id, facilityId),
      ),
    )
    .limit(1);
  const sets = [
    ...live.map((row) => row.operatingHours),
    ...(facility ? [facility.operatingHours] : []),
  ];
  if (sets.length === 0) return WFC_MAX_RESERVATION_MINUTES;
  const longest = Math.max(...sets.map(longestDayMinutes));
  return longest > 0 ? longest : WFC_MAX_RESERVATION_MINUTES;
}

type FloorProduct = {
  readonly facilityId: string;
  readonly access: WfcAccess;
  readonly seatFeeIdr: number;
  readonly creditIdr: number;
  readonly durationMinutes: number | null;
};

/** The first version the product falls under, with its floor; null = all met. */
async function firstFloorMiss(
  tx: Tx,
  context: ScopedTenantContext,
  product: FloorProduct,
  versions: readonly WfcSettingsRow[],
  today: string,
): Promise<number | null> {
  if (versions.length === 0) return null;
  const minutes =
    product.durationMinutes ??
    (await dayPassMinutes(tx, context, product.facilityId, today));
  for (const version of versions) {
    const check = checkWfcProductFloor(version, product, minutes);
    if (!check.ok) return check.floorIdr;
  }
  return null;
}

/**
 * Throws 422 WFC_PRICE_BELOW_FLOOR when the split falls under the floor of a
 * version in force or still to come. `requireInForce`: also 409
 * WFC_CONFIG_INCOMPLETE without a version in force (switching on, selling).
 */
export async function assertWfcProductFloor(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  product: FloorProduct,
  now: Date,
  options: { readonly requireInForce: boolean },
): Promise<void> {
  const live = await liveWfcSettings(tx, context, outletId, now);
  if (options.requireInForce && live.inForce === null)
    throw wfcConfigIncomplete();
  const today = await wfcBusinessDate(tx, context, outletId, now);
  const miss = await firstFloorMiss(tx, context, product, live.all, today);
  if (miss !== null) throw priceBelowFloor(miss);
}

function floorProductOf(row: ProductRow): FloorProduct | null {
  if (
    row.wfcKind === null ||
    row.wfcAccess === null ||
    row.seatFeeIdr === null ||
    row.creditIdr === null
  )
    return null;
  return {
    facilityId: row.facilityId,
    access: row.wfcAccess,
    seatFeeIdr: row.seatFeeIdr,
    creditIdr: row.creditIdr,
    durationMinutes: row.durationMinutes,
  };
}

/** Switches a WFC product on (floor checked) or off. */
export async function setWfcProductActive(
  context: ScopedTenantContext,
  actorUserId: string,
  input: SetWfcProductActiveInput,
  now = new Date(),
): Promise<WfcProduct> {
  const actor = userIdSchema.parse(actorUserId);
  const parsed = parseInput(setWfcProductActiveSchema, input);
  return withTenant(db, context, async (tx) => {
    const load = async () => {
      const [row] = await tx
        .select()
        .from(facilityProducts)
        .where(
          and(
            eq(facilityProducts.tenantId, context.tenant.tenantId),
            eq(facilityProducts.id, parsed.productId),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Produk");
      return row;
    };
    const found = await load();
    await assertFacilityPermission(
      tx,
      context,
      actor,
      POLICY_PERMISSION,
      found.outletId,
    );
    // Same order as a settings apply: outlet first, then the product row.
    await lockOutletSeats(tx, context, found.outletId);
    await lockConfigRow(tx, "facility_products", context, found.id);
    const existing = await load();
    assertConfigFresh(existing.updatedAt, parsed.expectedUpdatedAt);
    const floorProduct = floorProductOf(existing);
    if (floorProduct === null)
      throw new HttpError(409, "NOT_WFC_PRODUCT", "Bukan produk WFC.");
    if (existing.isActive === parsed.isActive) return toWfcProduct(existing);
    if (parsed.isActive)
      await assertWfcProductFloor(
        tx,
        context,
        existing.outletId,
        floorProduct,
        now,
        { requireInForce: true },
      );
    const [row] = await tx
      .update(facilityProducts)
      .set({ isActive: parsed.isActive, updatedAt: now })
      .where(
        and(
          eq(facilityProducts.tenantId, context.tenant.tenantId),
          eq(facilityProducts.id, existing.id),
        ),
      )
      .returning();
    await auditFacility(tx, context, actor, now, {
      action: "wfc_product.active",
      objectType: "facility_product",
      objectId: row.id,
      outletId: row.outletId,
      before: { id: existing.id, isActive: existing.isActive },
      after: { id: row.id, isActive: row.isActive, priceIdr: row.priceIdr },
    });
    return toWfcProduct(row);
  });
}

// ---- Proposals --------------------------------------------------------------

const settingsPending = () =>
  new HttpError(
    409,
    "WFC_SETTINGS_PENDING",
    "Masih ada usulan pengaturan WFC yang menunggu persetujuan.",
  );

async function outletRequests(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<RequestRow[]> {
  return tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, context.tenant.tenantId),
        eq(approvalRequests.sourceModule, WFC_APPROVAL_SOURCE_MODULE),
        eq(approvalRequests.objectType, WFC_SETTINGS_OBJECT_TYPE),
        eqId(approvalRequests.outletId, outletId),
      ),
    )
    .orderBy(asc(approvalRequests.createdAt), asc(approvalRequests.level));
}

/** Opens the approval of a new settings version; nothing applies yet. */
export async function proposeWfcSettings(
  context: ScopedTenantContext,
  actorUserId: string,
  input: ProposeWfcSettingsInput,
  now = new Date(),
): Promise<WfcSettingsProposal> {
  const actor = userIdSchema.parse(actorUserId);
  const parsed = parseInput(proposeWfcSettingsSchema, input);
  const { outletId, reason, ...numbers } = parsed;
  return withTenant(db, context, async (tx) => {
    await assertFacilityPermission(
      tx,
      context,
      actor,
      POLICY_PERMISSION,
      outletId,
    );
    await lockOutletSeats(tx, context, outletId);
    const requests = await outletRequests(tx, context, outletId);
    if (requests.some((row) => row.status === "pending"))
      throw settingsPending();
    const today = await wfcBusinessDate(tx, context, outletId, now);
    const [latest] = await tx
      .select({
        version: wfcBusinessSettings.version,
        effectiveFrom: wfcBusinessSettings.effectiveFrom,
      })
      .from(wfcBusinessSettings)
      .where(
        and(
          eq(wfcBusinessSettings.tenantId, context.tenant.tenantId),
          eqId(wfcBusinessSettings.outletId, outletId),
        ),
      )
      .orderBy(
        desc(wfcBusinessSettings.effectiveFrom),
        desc(wfcBusinessSettings.version),
      )
      .limit(1);
    const [top] = await tx
      .select({ version: wfcBusinessSettings.version })
      .from(wfcBusinessSettings)
      .where(
        and(
          eq(wfcBusinessSettings.tenantId, context.tenant.tenantId),
          eqId(wfcBusinessSettings.outletId, outletId),
        ),
      )
      .orderBy(desc(wfcBusinessSettings.version))
      .limit(1);
    if (
      numbers.effectiveFrom < today ||
      (latest !== undefined && numbers.effectiveFrom < latest.effectiveFrom)
    )
      throw new HttpError(
        409,
        "WFC_SETTINGS_BACKDATED",
        "Tanggal berlaku tidak boleh sebelum hari ini atau versi terakhir.",
      );
    if (numbers.wfcSeats < (await maxWfcQuota(tx, context, outletId)))
      throw new HttpError(
        409,
        "WFC_SEATS_BELOW_QUOTA",
        "Kursi WFC tidak boleh kurang dari kuota per jam tertinggi.",
      );
    const settingsId = randomUUID();
    const payload: WfcSettingsPayload = {
      outletId,
      version: (top?.version ?? 0) + 1,
      ...numbers,
    };
    const opened = await openApprovalRequest(tx, context, {
      sourceModule: WFC_APPROVAL_SOURCE_MODULE,
      actionType: WFC_APPROVAL_ACTION,
      objectType: WFC_SETTINGS_OBJECT_TYPE,
      objectId: settingsId,
      amountIdr: null,
      outletId,
      requestedBy: actor,
      source: "user",
      requestReason: reason,
      payload,
      alwaysRequire: true,
      now,
    });
    // Fail closed: a version is never written without a second person.
    if (!opened.required)
      throw new HttpError(
        409,
        "APPROVAL_POLICY_MISSING",
        "Belum ada aturan persetujuan untuk perubahan harga.",
      );
    const [head] = await tx
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, context.tenant.tenantId),
          eq(approvalRequests.id, opened.chainId),
        ),
      );
    await auditFacility(tx, context, actor, now, {
      action: "wfc_settings.proposed",
      objectType: WFC_SETTINGS_OBJECT_TYPE,
      objectId: settingsId,
      outletId,
      before: null,
      after: { ...payload },
    });
    return toProposal(head, head, false);
  });
}

/** Versions written and proposals of one outlet. */
export async function listWfcSettings(
  context: ScopedTenantContext,
  actorUserId: string,
  input: ListWfcSettingsInput,
): Promise<{
  versions: WfcBusinessSettings[];
  proposals: WfcSettingsProposal[];
}> {
  const actor = userIdSchema.parse(actorUserId);
  const { outletId } = parseInput(listWfcSettingsQuerySchema, input);
  return withTenant(db, context, async (tx) => {
    await assertFacilityPermission(
      tx,
      context,
      actor,
      POLICY_PERMISSION,
      outletId,
    );
    const versions = await tx
      .select()
      .from(wfcBusinessSettings)
      .where(
        and(
          eq(wfcBusinessSettings.tenantId, context.tenant.tenantId),
          eqId(wfcBusinessSettings.outletId, outletId),
        ),
      )
      .orderBy(desc(wfcBusinessSettings.version));
    const written = new Set(versions.map((row) => row.id));
    const chains = new Map<string, RequestRow[]>();
    for (const row of await outletRequests(tx, context, outletId))
      chains.set(row.chainId, [...(chains.get(row.chainId) ?? []), row]);
    const proposals = [...chains.values()]
      .map((rows) => {
        const sorted = [...rows].sort((a, b) => a.level - b.level);
        const head = sorted[0];
        const last = sorted[sorted.length - 1];
        return toProposal(head, last, written.has(head.objectId));
      })
      .reverse();
    return { versions: versions.map(toSettings), proposals };
  });
}

// ---- Apply ------------------------------------------------------------------

/**
 * Writes the version of an approved chain, inside the caller's transaction.
 * Returns the version (also when written before), or null when nothing may be
 * written: not ours, not approved, decided by the proposer or by someone
 * without `wfc.policy.manage`, a payload that does not parse, or a quota cell
 * that grew past the approved seats.
 */
export async function applyApprovedWfcSettings(
  tx: Tx,
  context: ScopedTenantContext,
  chainId: string,
  now: Date,
): Promise<WfcBusinessSettings | null> {
  const chain = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, context.tenant.tenantId),
        eq(approvalRequests.chainId, chainId),
      ),
    )
    .orderBy(asc(approvalRequests.level));
  const head = chain[0];
  if (
    !head ||
    head.sourceModule !== WFC_APPROVAL_SOURCE_MODULE ||
    head.objectType !== WFC_SETTINGS_OBJECT_TYPE ||
    head.actionType !== WFC_APPROVAL_ACTION ||
    head.outletId === null
  )
    return null;
  const outletId = head.outletId;
  await lockOutletSeats(tx, context, outletId);
  const byId = async () => {
    const [row] = await tx
      .select()
      .from(wfcBusinessSettings)
      .where(
        and(
          eq(wfcBusinessSettings.tenantId, context.tenant.tenantId),
          eq(wfcBusinessSettings.id, head.objectId),
        ),
      )
      .limit(1);
    return row ?? null;
  };
  const written = await byId();
  if (written) return toSettings(written);
  const outcome = await resolveApprovalChainOutcome(tx, context, {
    chainId,
    sourceModule: WFC_APPROVAL_SOURCE_MODULE,
    now,
  });
  if (outcome !== "approved") return null;
  const [last] = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, context.tenant.tenantId),
        eq(approvalRequests.chainId, chainId),
      ),
    )
    .orderBy(desc(approvalRequests.level))
    .limit(1);
  const payload = wfcSettingsPayloadSchema.safeParse(last?.payload);
  if (
    !last ||
    !payload.success ||
    payload.data.outletId.toLowerCase() !== outletId.toLowerCase() ||
    payload.data.wfcSeats > payload.data.totalSeats ||
    last.decidedBy === null ||
    last.decidedBy === head.requestedBy
  )
    return null;
  const approver = userIdSchema.parse(last.decidedBy);
  try {
    await assertFacilityPermission(
      tx,
      context,
      approver,
      POLICY_PERMISSION,
      outletId,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) return null;
    throw error;
  }
  if (payload.data.wfcSeats < (await maxWfcQuota(tx, context, outletId)))
    return null;
  const { version, ...numbers } = payload.data;
  const [row] = await tx
    .insert(wfcBusinessSettings)
    .values({
      id: head.objectId,
      tenantId: context.tenant.tenantId,
      version,
      ...numbers,
      outletId,
      reason: head.requestReason,
      proposedBy: head.requestedBy,
      approvedBy: approver,
      approvalRequestId: last.id,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning();
  // A version number taken by another chain in the meantime: nothing written.
  if (!row) return null;
  await auditFacility(tx, context, approver, now, {
    action: "wfc_settings.applied",
    objectType: WFC_SETTINGS_OBJECT_TYPE,
    objectId: row.id,
    outletId,
    before: null,
    after: { ...payload.data, approvalRequestId: last.id },
  });
  await switchOffBelowFloor(tx, context, outletId, approver, now);
  return toSettings(row);
}

/** Switches off every active WFC product of the outlet now under a floor. */
async function switchOffBelowFloor(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  actor: string,
  now: Date,
): Promise<void> {
  const live = await liveWfcSettings(tx, context, outletId, now);
  const today = await wfcBusinessDate(tx, context, outletId, now);
  const active = await tx
    .select()
    .from(facilityProducts)
    .where(
      and(
        eq(facilityProducts.tenantId, context.tenant.tenantId),
        eqId(facilityProducts.outletId, outletId),
        isNotNull(facilityProducts.wfcKind),
        eq(facilityProducts.isActive, true),
      ),
    );
  const below: ProductRow[] = [];
  for (const product of active) {
    const floorProduct = floorProductOf(product);
    if (
      floorProduct === null ||
      (await firstFloorMiss(tx, context, floorProduct, live.all, today)) !==
        null
    )
      below.push(product);
  }
  if (below.length === 0) return;
  await tx
    .update(facilityProducts)
    .set({ isActive: false, updatedAt: now })
    .where(
      and(
        eq(facilityProducts.tenantId, context.tenant.tenantId),
        inArray(
          facilityProducts.id,
          below.map((row) => row.id),
        ),
      ),
    );
  for (const product of below)
    await auditFacility(tx, context, actor, now, {
      action: "wfc_product.active",
      objectType: "facility_product",
      objectId: product.id,
      outletId,
      before: { id: product.id, isActive: true },
      after: { id: product.id, isActive: false, reason: "below_floor" },
    });
}

/** The apply route: the caller holds `wfc.policy.manage` on the outlet. */
export async function applyWfcSettings(
  context: ScopedTenantContext,
  actorUserId: string,
  input: ApplyWfcSettingsInput,
  now = new Date(),
): Promise<WfcBusinessSettings> {
  const actor = userIdSchema.parse(actorUserId);
  const { chainId } = parseInput(applyWfcSettingsSchema, input);
  return withTenant(db, context, async (tx) => {
    const [head] = await tx
      .select({
        outletId: approvalRequests.outletId,
        sourceModule: approvalRequests.sourceModule,
        objectType: approvalRequests.objectType,
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, context.tenant.tenantId),
          eq(approvalRequests.id, chainId),
        ),
      )
      .limit(1);
    if (
      !head ||
      head.outletId === null ||
      head.sourceModule !== WFC_APPROVAL_SOURCE_MODULE ||
      head.objectType !== WFC_SETTINGS_OBJECT_TYPE
    )
      throw notFound("Usulan pengaturan WFC");
    await assertFacilityPermission(
      tx,
      context,
      actor,
      POLICY_PERMISSION,
      head.outletId,
    );
    const applied = await applyApprovedWfcSettings(tx, context, chainId, now);
    if (!applied)
      throw new HttpError(
        409,
        "WFC_SETTINGS_NOT_APPROVED",
        "Usulan ini belum disetujui orang lain yang berwenang, atau tidak bisa diterapkan.",
      );
    return applied;
  });
}

// ---- approval.resolved consumer --------------------------------------------

function payloadField(event: EventEnvelope, key: string): unknown {
  const payload: unknown = event.payload;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Applies an approved settings chain. The event is only a trigger: the chain
 * is re-read under its lock. Ignores other modules, tenants and outcomes;
 * replay safe (the version id is the key).
 */
export async function handleWfcSettingsApprovalResolved(
  context: ScopedTenantContext,
  event: EventEnvelope,
  now: Date = new Date(),
): Promise<void> {
  if (event.name !== approvalResolvedEvent.name) return;
  if (payloadField(event, "sourceModule") !== WFC_APPROVAL_SOURCE_MODULE)
    return;
  if (payloadField(event, "objectType") !== WFC_SETTINGS_OBJECT_TYPE) return;
  const parsed = approvalResolvedEvent.envelopeSchema.safeParse(event);
  if (!parsed.success) return;
  if (
    parsed.data.tenantId.toLowerCase() !==
    context.tenant.tenantId.toLowerCase()
  )
    return;
  await withTenant(db, context, (tx) =>
    applyApprovedWfcSettings(tx, context, parsed.data.payload.chainId, now),
  );
}
