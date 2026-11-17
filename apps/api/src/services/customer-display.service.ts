// Customer display backend (design legend-yhia9 D-08, migration 0370).
//
// - A display device asks for a six-digit code (5 minutes, single use, one live
//   code per display); only an HMAC of it is stored, bound to tenant and outlet.
// - The cashier types the code on the terminal: one active pairing per display
//   and per terminal, re-pairing revokes the old one. Wrong codes take a slot
//   first (5 per terminal and 20 per outlet in 5 minutes, then 429).
// - The cashier chooses the bill the display shows (never guessed).
// - The state is built only here, from the selected order, its captured
//   tenders and its QRIS hold. The QR is shown only while the hold is `open`
//   AND its amount equals the remaining amount; the client never sends one.
import { createHmac, randomInt } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  CoreError,
  ulidToUuid,
  type OutletId,
  type TenantContext,
  type TenantId,
} from "@starter/shared/core";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import {
  customerDisplayPairAttempts,
  customerDisplayPairingCodes,
  customerDisplayPairings,
  customerDisplaySessions,
} from "../db/schema/customer-display.ts";
import { devices } from "../db/schema/device.ts";
import { paymentIntents } from "../db/schema/payment.ts";
import { posOrderTenders } from "../db/schema/pos-order.ts";
import { posQrisHolds } from "../db/schema/pos-qris-hold.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import { outletContext } from "./device-pin-support.ts";
import type { Tx } from "./menu-internals.ts";

export const PAIRING_CODE_TTL_MS = 5 * 60_000;
export const PAIR_WINDOW_MS = 5 * 60_000;
export const PAIR_TERMINAL_MAX = 5;
export const PAIR_OUTLET_MAX = 20;
const CODE_ATTEMPTS = 8;
const QR_PROVIDERS = ["doit", "duitku"] as const;

/** One answer for unpaired, revoked, foreign-outlet and unknown displays. */
export function notPaired(): HttpError {
  return new HttpError(
    404,
    "DISPLAY_NOT_PAIRED",
    "Layar pelanggan ini belum terhubung ke kasir.",
  );
}

function codeKey(): Buffer {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update("legend.customer-display-code.v1")
    .digest();
}

function hashCode(
  tenantId: TenantId,
  outletId: OutletId,
  code: string,
): Buffer {
  return createHmac("sha256", codeKey())
    .update(`${tenantId}:${outletId}:${code}`)
    .digest();
}

type DeviceType = "pos" | "display" | string;

/** The active device of this outlet (RLS hides every other outlet and tenant). */
async function activeDevice(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
  deviceId: string,
): Promise<{ id: string; type: DeviceType } | null> {
  const [row] = await tx
    .select({ id: devices.id, type: devices.type })
    .from(devices)
    .where(
      and(
        eq(devices.tenantId, tenantId),
        eq(devices.outletId, outletId),
        eq(devices.id, deviceId),
        eq(devices.status, "active"),
      ),
    );
  return row ?? null;
}

/** The type of an active device in this outlet; null when none (no hint). */
export async function displayDeviceTypeOf(
  tenant: TenantContext,
  outletId: OutletId,
  deviceId: string,
): Promise<DeviceType | null> {
  const context = outletContext(tenant, outletId);
  return withTenant(db, context, async (tx) => {
    const row = await activeDevice(tx, tenant.tenantId, outletId, deviceId);
    return row?.type ?? null;
  });
}

// ---- Pairing code ---------------------------------------------------------------

export async function issuePairingCode(
  tenant: TenantContext,
  outletId: OutletId,
  displayDeviceId: string,
  now = new Date(),
): Promise<{ code: string; expiresAt: string }> {
  const context = outletContext(tenant, outletId);
  const tenantId = tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const device = await activeDevice(tx, tenantId, outletId, displayDeviceId);
    if (!device || device.type !== "display")
      throw new HttpError(
        403,
        "DISPLAY_DEVICE_REQUIRED",
        "Hanya perangkat layar pelanggan yang dapat meminta kode.",
      );
    // One live code per display: a newer code replaces the older one.
    await tx
      .update(customerDisplayPairingCodes)
      .set({ consumedAt: now })
      .where(
        and(
          eq(customerDisplayPairingCodes.tenantId, tenantId),
          eq(customerDisplayPairingCodes.displayDeviceId, displayDeviceId),
          isNull(customerDisplayPairingCodes.consumedAt),
        ),
      );
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const codeHash = hashCode(tenantId, outletId, code);
      const [taken] = await tx
        .select({ id: customerDisplayPairingCodes.id })
        .from(customerDisplayPairingCodes)
        .where(
          and(
            eq(customerDisplayPairingCodes.tenantId, tenantId),
            eq(customerDisplayPairingCodes.outletId, outletId),
            eq(customerDisplayPairingCodes.codeHash, codeHash),
            isNull(customerDisplayPairingCodes.consumedAt),
          ),
        );
      if (taken) continue;
      const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);
      await tx.insert(customerDisplayPairingCodes).values({
        tenantId,
        outletId,
        displayDeviceId,
        codeHash,
        expiresAt,
        createdAt: now,
      });
      return { code, expiresAt: expiresAt.toISOString() };
    }
    throw new Error("could not mint a free customer display pairing code");
  });
}

// ---- Pair ---------------------------------------------------------------------------

type PairingRow = typeof customerDisplayPairings.$inferSelect;

function pairingDto(row: PairingRow) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    terminalDeviceId: row.terminalDeviceId,
    displayDeviceId: row.displayDeviceId,
    status: row.status,
    pairedAt: row.pairedAt.toISOString(),
    pairedBy: row.pairedBy,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export class PairThrottledError extends HttpError {
  constructor(readonly retryAfterSeconds: number) {
    super(
      429,
      "PAIR_THROTTLED",
      "Terlalu banyak kode salah. Coba lagi beberapa menit lagi.",
    );
    this.name = "PairThrottledError";
  }
}

/**
 * Takes a slot before the code is checked (and before the cashier permission,
 * so a denied or unauthorised guess counts too), in its own committed transaction,
 * so parallel guesses cannot all pass a stale count. Over the limit the slot is
 * given back and the answer is 429.
 */
export async function reservePairSlot(
  tenant: TenantContext,
  outletId: OutletId,
  terminalDeviceId: string,
  now = new Date(),
): Promise<string> {
  const context = outletContext(tenant, outletId);
  const tenantId = tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const terminal = await activeDevice(
      tx,
      tenantId,
      outletId,
      terminalDeviceId,
    );
    if (!terminal || terminal.type === "display")
      throw new HttpError(
        403,
        "TERMINAL_DEVICE_REQUIRED",
        "Pairing dilakukan dari perangkat kasir yang terdaftar.",
      );
    // One slot decision at a time per outlet: parallel guesses would otherwise
    // each count before the others commit and all slip under the limit.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-display-pair-slot:${tenantId}:${outletId}`}, 0))`,
    );
    const [slot] = await tx
      .insert(customerDisplayPairAttempts)
      .values({ tenantId, outletId, terminalDeviceId, attemptedAt: now })
      .returning({ id: customerDisplayPairAttempts.id });
    const since = new Date(now.getTime() - PAIR_WINDOW_MS);
    const inWindow = and(
      eq(customerDisplayPairAttempts.tenantId, tenantId),
      eq(customerDisplayPairAttempts.outletId, outletId),
      gt(customerDisplayPairAttempts.attemptedAt, since),
    );
    const [outletCount] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(customerDisplayPairAttempts)
      .where(inWindow);
    const [terminalCount] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(customerDisplayPairAttempts)
      .where(
        and(
          inWindow,
          eq(customerDisplayPairAttempts.terminalDeviceId, terminalDeviceId),
        ),
      );
    if (
      (terminalCount?.n ?? 0) > PAIR_TERMINAL_MAX ||
      (outletCount?.n ?? 0) > PAIR_OUTLET_MAX
    ) {
      await tx
        .delete(customerDisplayPairAttempts)
        .where(
          and(
            eq(customerDisplayPairAttempts.tenantId, tenantId),
            eq(customerDisplayPairAttempts.id, slot!.id),
          ),
        );
      const [oldest] = await tx
        .select({ at: customerDisplayPairAttempts.attemptedAt })
        .from(customerDisplayPairAttempts)
        .where(inWindow)
        .orderBy(asc(customerDisplayPairAttempts.attemptedAt))
        .limit(1);
      const endsAt = (oldest?.at ?? now).getTime() + PAIR_WINDOW_MS;
      throw new PairThrottledError(
        Math.max(1, Math.ceil((endsAt - now.getTime()) / 1000)),
      );
    }
    return slot!.id;
  });
}

export async function pairCustomerDisplay(
  tenant: TenantContext,
  outletId: OutletId,
  terminalDeviceId: string,
  userId: string,
  code: string,
  slotId: string,
  now = new Date(),
) {
  const context = outletContext(tenant, outletId);
  const tenantId = tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [live] = await tx
      .select()
      .from(customerDisplayPairingCodes)
      .where(
        and(
          eq(customerDisplayPairingCodes.tenantId, tenantId),
          eq(customerDisplayPairingCodes.outletId, outletId),
          eq(
            customerDisplayPairingCodes.codeHash,
            hashCode(tenantId, outletId, code),
          ),
          isNull(customerDisplayPairingCodes.consumedAt),
          gt(customerDisplayPairingCodes.expiresAt, now),
        ),
      )
      .for("update");
    if (!live) {
      // Replay of a pair that already succeeded (a retry after a lost answer):
      // this terminal's active pairing was made by consuming exactly this code,
      // so it is returned again. Nothing new is granted.
      const [replay] = await tx
        .select({ pairing: customerDisplayPairings })
        .from(customerDisplayPairingCodes)
        .innerJoin(
          customerDisplayPairings,
          and(
            eq(
              customerDisplayPairings.tenantId,
              customerDisplayPairingCodes.tenantId,
            ),
            eq(
              customerDisplayPairings.displayDeviceId,
              customerDisplayPairingCodes.displayDeviceId,
            ),
            eq(
              customerDisplayPairings.pairedAt,
              customerDisplayPairingCodes.consumedAt,
            ),
          ),
        )
        .where(
          and(
            eq(customerDisplayPairingCodes.tenantId, tenantId),
            eq(customerDisplayPairingCodes.outletId, outletId),
            eq(
              customerDisplayPairingCodes.codeHash,
              hashCode(tenantId, outletId, code),
            ),
            eq(customerDisplayPairings.terminalDeviceId, terminalDeviceId),
            eq(customerDisplayPairings.status, "active"),
          ),
        );
      if (replay) {
        await tx
          .delete(customerDisplayPairAttempts)
          .where(
            and(
              eq(customerDisplayPairAttempts.tenantId, tenantId),
              eq(customerDisplayPairAttempts.id, slotId),
            ),
          );
        return pairingDto(replay.pairing);
      }
      throw new HttpError(
        400,
        "PAIRING_CODE_INVALID",
        "Kode tidak berlaku. Minta kode baru di layar pelanggan.",
      );
    }
    const display = await activeDevice(
      tx,
      tenantId,
      outletId,
      live.displayDeviceId,
    );
    if (!display || display.type !== "display")
      throw new HttpError(
        400,
        "PAIRING_CODE_INVALID",
        "Kode tidak berlaku. Minta kode baru di layar pelanggan.",
      );
    await tx
      .update(customerDisplayPairingCodes)
      .set({ consumedAt: now })
      .where(
        and(
          eq(customerDisplayPairingCodes.tenantId, tenantId),
          eq(customerDisplayPairingCodes.id, live.id),
        ),
      );
    // One active pairing per display and per terminal: the old one is revoked.
    await tx
      .update(customerDisplayPairings)
      .set({ status: "revoked", revokedAt: now, revokedBy: userId })
      .where(
        and(
          eq(customerDisplayPairings.tenantId, tenantId),
          eq(customerDisplayPairings.status, "active"),
          sql`(${customerDisplayPairings.displayDeviceId} = ${live.displayDeviceId} OR ${customerDisplayPairings.terminalDeviceId} = ${terminalDeviceId})`,
        ),
      );
    const [pairing] = await tx
      .insert(customerDisplayPairings)
      .values({
        tenantId,
        outletId,
        terminalDeviceId,
        displayDeviceId: live.displayDeviceId,
        status: "active",
        pairedAt: now,
        pairedBy: userId,
      })
      .returning();
    // A newly paired display starts idle: the bill chosen for an earlier
    // display of this terminal is not carried over. The version only grows.
    await tx
      .insert(customerDisplaySessions)
      .values({
        tenantId,
        terminalDeviceId,
        outletId,
        selectedOrderId: null,
        version: 1,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          customerDisplaySessions.tenantId,
          customerDisplaySessions.terminalDeviceId,
        ],
        set: {
          selectedOrderId: null,
          version: sql`${customerDisplaySessions.version} + 1`,
          updatedAt: now,
        },
      });
    // A right code gives its slot back: only wrong guesses count.
    await tx
      .delete(customerDisplayPairAttempts)
      .where(
        and(
          eq(customerDisplayPairAttempts.tenantId, tenantId),
          eq(customerDisplayPairAttempts.id, slotId),
        ),
      );
    return pairingDto(pairing!);
  });
}

export async function revokeCustomerDisplayPairing(
  tenant: TenantContext,
  outletId: OutletId,
  pairingId: string,
  userId: string,
  now = new Date(),
) {
  const context = outletContext(tenant, outletId);
  const tenantId = tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [revoked] = await tx
      .update(customerDisplayPairings)
      .set({ status: "revoked", revokedAt: now, revokedBy: userId })
      .where(
        and(
          eq(customerDisplayPairings.tenantId, tenantId),
          eq(customerDisplayPairings.outletId, outletId),
          eq(customerDisplayPairings.id, pairingId),
          eq(customerDisplayPairings.status, "active"),
        ),
      )
      .returning();
    if (revoked) return pairingDto(revoked);
    const [existing] = await tx
      .select()
      .from(customerDisplayPairings)
      .where(
        and(
          eq(customerDisplayPairings.tenantId, tenantId),
          eq(customerDisplayPairings.outletId, outletId),
          eq(customerDisplayPairings.id, pairingId),
        ),
      );
    if (!existing)
      throw new CoreError("NOT_FOUND", "Pairing layar tidak ditemukan.");
    return pairingDto(existing);
  });
}

// ---- Selection ------------------------------------------------------------------------

async function activePairingOfTerminal(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
  terminalDeviceId: string,
): Promise<PairingRow | null> {
  const [row] = await tx
    .select()
    .from(customerDisplayPairings)
    .where(
      and(
        eq(customerDisplayPairings.tenantId, tenantId),
        eq(customerDisplayPairings.outletId, outletId),
        eq(customerDisplayPairings.terminalDeviceId, terminalDeviceId),
        eq(customerDisplayPairings.status, "active"),
      ),
    );
  return row ?? null;
}

async function applySelection(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
  terminalDeviceId: string,
  orderId: string | null,
  now: Date,
) {
  if (orderId !== null) {
    const [order] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.outletId, outletId),
          eq(orders.id, orderId),
        ),
      )
      // The FK of the session row needs the order to stay until we commit.
      .for("key share");
    if (!order) throw new CoreError("NOT_FOUND", "Pesanan tidak ditemukan.");
  }
  const orderUuid = orderId === null ? null : ulidToUuid(orderId);
  // A new row starts at version 1; a changed selection bumps it; the same
  // selection again changes nothing (idempotent replay).
  await tx
    .insert(customerDisplaySessions)
    .values({
      tenantId,
      terminalDeviceId,
      outletId,
      selectedOrderId: orderId,
      version: 1,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        customerDisplaySessions.tenantId,
        customerDisplaySessions.terminalDeviceId,
      ],
      set: {
        selectedOrderId: orderId,
        version: sql`${customerDisplaySessions.version} + 1`,
        updatedAt: now,
      },
      // Raw SQL does not convert the ULID like the column does.
      setWhere: sql`${customerDisplaySessions.selectedOrderId} IS DISTINCT FROM ${orderUuid}::uuid`,
    });
  const [session] = await tx
    .select()
    .from(customerDisplaySessions)
    .where(
      and(
        eq(customerDisplaySessions.tenantId, tenantId),
        eq(customerDisplaySessions.terminalDeviceId, terminalDeviceId),
      ),
    );
  return {
    tenantId,
    outletId,
    terminalDeviceId,
    orderId: session!.selectedOrderId,
    version: Number(session!.version),
    updatedAt: session!.updatedAt.toISOString(),
  };
}

/** PUT .../selection: the cashier picks the bill (null: idle). */
export async function selectCustomerDisplayBill(
  tenant: TenantContext,
  outletId: OutletId,
  terminalDeviceId: string,
  orderId: string | null,
  now = new Date(),
) {
  const context = outletContext(tenant, outletId);
  const tenantId = tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    if (
      !(await activePairingOfTerminal(tx, tenantId, outletId, terminalDeviceId))
    )
      throw new HttpError(
        409,
        "DISPLAY_NOT_PAIRED",
        "Terminal ini belum terhubung ke layar pelanggan.",
      );
    return applySelection(
      tx,
      tenantId,
      outletId,
      terminalDeviceId,
      orderId,
      now,
    );
  });
}

/**
 * legend-yhia9 D-08 hook: a QR issued from a terminal puts that bill on its
 * display. Called by the tender route right after the QR tender committed. A
 * terminal without a paired display, or any failure here, never fails the
 * tender: the cashier can still select the bill by hand.
 */
export async function selectBillAfterQrisIssued(
  tenant: TenantContext,
  outletId: OutletId,
  terminalDeviceId: string,
  orderId: string,
  now = new Date(),
): Promise<void> {
  try {
    const context = outletContext(tenant, outletId);
    const tenantId = tenant.tenantId;
    await withTenant(db, context, async (tx) => {
      if (
        !(await activePairingOfTerminal(
          tx,
          tenantId,
          outletId,
          terminalDeviceId,
        ))
      )
        return;
      await applySelection(
        tx,
        tenantId,
        outletId,
        terminalDeviceId,
        orderId,
        now,
      );
    });
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : "unknown" },
      "customer display: could not select the bill after the QR was issued",
    );
  }
}

// ---- State ------------------------------------------------------------------------------

async function buildState(tx: Tx, pairing: PairingRow, now: Date) {
  const tenantId = pairing.tenantId;
  const [session] = await tx
    .select()
    .from(customerDisplaySessions)
    .where(
      and(
        eq(customerDisplaySessions.tenantId, tenantId),
        eq(customerDisplaySessions.terminalDeviceId, pairing.terminalDeviceId),
      ),
    );
  const base = {
    tenantId,
    outletId: pairing.outletId,
    terminalDeviceId: pairing.terminalDeviceId,
    displayDeviceId: pairing.displayDeviceId,
    // No promotion source exists yet; a paired display has no pairing code.
    promotions: [],
    pairingCode: null,
    version: Number(session?.version ?? 0),
    updatedAt: (session?.updatedAt ?? pairing.pairedAt).toISOString(),
  };
  const idle = {
    ...base,
    state: "idle" as const,
    orderId: null,
    orderNumber: null,
    lines: [],
    subtotalIdr: 0,
    discountIdr: 0,
    serviceChargeIdr: 0,
    taxIdr: 0,
    roundingIdr: 0,
    totalIdr: 0,
    depositAppliedIdr: 0,
    remainingIdr: 0,
    qris: null,
    tenders: [],
    changeIdr: null,
  };
  if (!session?.selectedOrderId) return idle;
  const [order] = await tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.outletId, pairing.outletId),
        eq(orders.id, session.selectedOrderId),
      ),
    );
  if (!order) return idle;
  const lines = await tx
    .select()
    .from(orderItems)
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        eq(orderItems.orderId, order.id),
        ne(orderItems.status, "voided"),
      ),
    )
    .orderBy(asc(orderItems.id));
  const tenders = await tx
    .select()
    .from(posOrderTenders)
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantId),
        eq(posOrderTenders.orderId, order.id),
        eq(posOrderTenders.status, "captured"),
      ),
    )
    .orderBy(asc(posOrderTenders.createdAt), asc(posOrderTenders.id));
  const total = Number(order.totalIdr);
  const deposit = Number(order.depositAppliedIdr);
  const captured = tenders.reduce((sum, t) => sum + Number(t.amountIdr), 0);
  const remaining = total - deposit - captured;

  let qris: {
    provider: (typeof QR_PROVIDERS)[number];
    amountIdr: number;
    payload: string;
    expiresAt: string;
  } | null = null;
  const [hold] = await tx
    .select()
    .from(posQrisHolds)
    .where(
      and(
        eq(posQrisHolds.tenantId, tenantId),
        eq(posQrisHolds.orderId, order.id),
        inArray(posQrisHolds.state, ["open"]),
      ),
    )
    .orderBy(desc(posQrisHolds.openedAt))
    .limit(1);
  // D-08: the hold must be open AND exactly the remaining amount.
  if (hold && remaining > 0 && Number(hold.amountIdr) === remaining) {
    const [intent] = await tx
      .select({
        provider: paymentIntents.provider,
        instructions: paymentIntents.instructions,
        expiresAt: paymentIntents.expiresAt,
      })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          eq(paymentIntents.id, hold.paymentIntentId),
        ),
      );
    const provider = QR_PROVIDERS.find((p) => p === intent?.provider);
    const instructions = intent?.instructions as
      { method?: string; qrPayload?: string } | undefined;
    if (
      intent &&
      provider &&
      instructions?.method === "qris" &&
      typeof instructions.qrPayload === "string" &&
      instructions.qrPayload.length >= 16 &&
      intent.expiresAt.getTime() > now.getTime()
    )
      qris = {
        provider,
        amountIdr: remaining,
        payload: instructions.qrPayload,
        expiresAt: intent.expiresAt.toISOString(),
      };
  }
  const changes = tenders
    .map((t) => (t.changeIdr === null ? null : Number(t.changeIdr)))
    .filter((c): c is number => c !== null);
  // Prices that already include tax and service: the screen shows them inside
  // the lines, so the printed breakdown adds up to the total.
  const included = order.pricesIncludeTax;
  return {
    ...base,
    state:
      qris !== null
        ? ("awaiting_payment" as const)
        : remaining === 0 && total > 0
          ? ("paid" as const)
          : order.status === "draft"
            ? ("ordering" as const)
            : ("awaiting_payment" as const),
    orderId: order.id,
    orderNumber: order.number,
    lines: lines.map((line) => ({
      name: line.name,
      quantity: Number(line.quantity),
      unitPriceIdr: Number(line.unitPriceIdr),
      lineTotalIdr: Number(line.lineTotalIdr),
      note: line.note,
    })),
    subtotalIdr: Number(order.subtotalIdr),
    discountIdr: Number(order.discountIdr),
    serviceChargeIdr: included ? 0 : Number(order.serviceChargeIdr),
    taxIdr: included ? 0 : Number(order.taxIdr),
    roundingIdr: Number(order.roundingIdr),
    totalIdr: total,
    depositAppliedIdr: deposit,
    remainingIdr: remaining,
    qris,
    tenders: tenders.map((t) => ({
      method: t.method,
      amountIdr: Number(t.amountIdr),
      reference: t.reference,
    })),
    changeIdr: changes.length > 0 ? changes.reduce((a, b) => a + b, 0) : null,
  };
}

/** GET .../customer-display as the display device: its own active pairing only. */
export async function readStateForDisplay(
  tenant: TenantContext,
  outletId: OutletId,
  displayDeviceId: string,
  now = new Date(),
) {
  const context = outletContext(tenant, outletId);
  const tenantId = tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [pairing] = await tx
      .select()
      .from(customerDisplayPairings)
      .where(
        and(
          eq(customerDisplayPairings.tenantId, tenantId),
          eq(customerDisplayPairings.outletId, outletId),
          eq(customerDisplayPairings.displayDeviceId, displayDeviceId),
          eq(customerDisplayPairings.status, "active"),
        ),
      );
    if (!pairing) throw notPaired();
    return buildState(tx, pairing, now);
  });
}

/** GET .../customer-display?terminalDeviceId= as the cashier (preview). */
export async function readStateForTerminal(
  tenant: TenantContext,
  outletId: OutletId,
  terminalDeviceId: string,
  now = new Date(),
) {
  const context = outletContext(tenant, outletId);
  const tenantId = tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    // The id must be an active terminal (not a display) of this very outlet
    // and tenant, filtered in SQL. Every refusal is the same 404 as an
    // unpaired terminal, so a foreign id leaks neither a bill nor its existence.
    const terminal = await activeDevice(
      tx,
      tenantId,
      outletId,
      terminalDeviceId,
    );
    if (!terminal || terminal.type === "display") throw notPaired();
    const pairing = await activePairingOfTerminal(
      tx,
      tenantId,
      outletId,
      terminalDeviceId,
    );
    if (!pairing) throw notPaired();
    return buildState(tx, pairing, now);
  });
}
