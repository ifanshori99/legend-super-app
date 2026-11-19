// Supervisor alert of money the provider refunded after we recorded it (bead
// legend-7uqbs, 958): a payment parked as unallocated funds, or a bill settled
// paid, whose provider payment now answers `refunded`. The money went back to
// the payer, so staff must not refund it again and must decide about the books
// (nothing is reversed automatically). One alert per (tenant, intent, provider
// transaction): the id is derived from them, the notification consumer ignores
// an event id it has seen, and the caller sends it only for the answer that won
// the conditional UPDATE, so a webhook and a poller racing still yield one.
import { createHash } from "node:crypto";
import {
  outletIdSchema,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { logger } from "../lib/logger.ts";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert.ts";
import type { Tx } from "./permission-resolver.ts";

export type ProviderRefundedAfterRecorded = {
  intentId: string;
  outletId: string;
  /** The provider transaction that answered `refunded`. */
  providerRef: string;
  /** Parked funds just marked (may be empty when only the bill was marked). */
  fundIds: readonly string[];
  /** The settled (paid) intent was just marked. */
  paidIntent: boolean;
  amountIdr: number;
};

/** Stable alert id for one intent and provider transaction. */
export function providerRefundedAlertId(
  tenantId: string,
  intentId: string,
  providerRef: string,
): string {
  const hex = createHash("sha256")
    .update(
      `payment.provider_refunded_after_recorded\0${tenantId}\0${intentId.toLowerCase()}\0${providerRef}`,
    )
    .digest("hex")
    .slice(0, 32);
  return uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

/**
 * Alerts the outlet supervisors (and owners) inside the caller's transaction.
 * A savepoint keeps a failed alarm from aborting the marking and the audit row
 * that already carry the fact.
 */
export async function alertProviderRefundedAfterRecorded(
  tx: Tx,
  context: ScopedTenantContext,
  refunded: ProviderRefundedAfterRecorded,
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const id = providerRefundedAlertId(
    tenantId,
    refunded.intentId,
    refunded.providerRef,
  );
  try {
    await tx.transaction(async (savepoint) => {
      await notifyOutletSupervisors(
        savepoint,
        context,
        {
          tenantId,
          outletId: outletIdSchema.parse(refunded.outletId),
          category: "operational_anomaly",
          alsoOwners: true,
          // An outlet with nobody to receive it still keeps the record.
          recordEmpty: true,
          id,
          eventName: "payment.provider_refunded_after_recorded",
          aggregateType: "payment",
          aggregateId: id,
          payload: {
            intentId: refunded.intentId,
            funds: String(refunded.fundIds.length),
            paidIntent: refunded.paidIntent ? "true" : "false",
          },
          title: "Pembayaran sudah dikembalikan oleh penyedia",
          body: `Penyedia pembayaran sudah mengembalikan Rp ${refunded.amountIdr.toLocaleString("id-ID")} ke pembayar untuk uang yang sudah tercatat. Jangan refund lagi; periksa pembukuan dan putuskan koreksinya. Tidak ada jurnal yang dibalik otomatis.`,
        },
        now,
      );
    });
  } catch (err) {
    logger.warn(
      { err, tenantId, intentId: refunded.intentId },
      "Provider refunded after recorded: notification failed",
    );
  }
}

export type ProviderPartialRefundAlert = {
  intentId: string;
  outletId: string;
  providerRefundId: string;
  /** What this one provider refund returned. */
  amountIdr: number;
  /** What the provider refunded in total for the intent so far. */
  cumulativeIdr: number;
};

/** Stable alert id for one provider refund of one intent (967): each distinct
 * refund is one alert, a webhook, a poller and a retry of it are the same. */
export function providerPartialRefundAlertId(
  tenantId: string,
  intentId: string,
  providerRefundId: string,
): string {
  const hex = createHash("sha256")
    .update(
      `payment.provider_refunded_partial\0${tenantId}\0${intentId.toLowerCase()}\0${providerRefundId}`,
    )
    .digest("hex")
    .slice(0, 32);
  return uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

/**
 * legend-30hfs (967): alerts the supervisors that the provider refunded part
 * (or all) of a payment on its own. Sent only by the winner of the insert of
 * that refund (`recordProviderRefundInTx`). Same savepoint rule as above.
 */
export async function alertProviderPartialRefund(
  tx: Tx,
  context: ScopedTenantContext,
  refunded: ProviderPartialRefundAlert,
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const id = providerPartialRefundAlertId(
    tenantId,
    refunded.intentId,
    refunded.providerRefundId,
  );
  try {
    await tx.transaction(async (savepoint) => {
      await notifyOutletSupervisors(
        savepoint,
        context,
        {
          tenantId,
          outletId: outletIdSchema.parse(refunded.outletId),
          category: "operational_anomaly",
          alsoOwners: true,
          recordEmpty: true,
          id,
          eventName: "payment.provider_refunded_partial",
          aggregateType: "payment",
          aggregateId: id,
          payload: {
            intentId: refunded.intentId,
            amountIdr: String(refunded.amountIdr),
            cumulativeIdr: String(refunded.cumulativeIdr),
          },
          title: "Penyedia mengembalikan sebagian pembayaran",
          body: `Penyedia pembayaran mengembalikan Rp ${refunded.amountIdr.toLocaleString("id-ID")} ke pembayar untuk pembayaran yang sudah tercatat (total dikembalikan penyedia Rp ${refunded.cumulativeIdr.toLocaleString("id-ID")}). Jumlah yang masih bisa di-refund dikurangi sebesar itu. Periksa pembukuan dan putuskan koreksinya; tidak ada jurnal yang dibalik otomatis.`,
        },
        now,
      );
    });
  } catch (err) {
    logger.warn(
      { err, tenantId, intentId: refunded.intentId },
      "Provider partial refund: notification failed",
    );
  }
}

export type RefundReferenceMismatchAlert = {
  /** The intent that owns the payment id of the event (the one held). */
  intentId: string;
  outletId: string;
  /** The provider's refund id, when the event carries one. */
  providerRefundId: string | null;
  amountIdr: number;
};

/** Stable alert id for one provider refund naming another intent: the same
 * refund resent under a new event id, a webhook retry and a worker retry are
 * one alert. */
export function refundReferenceMismatchAlertId(
  tenantId: string,
  intentId: string,
  providerRefundId: string | null,
  webhookEventId: string,
): string {
  const hex = createHash("sha256")
    .update(
      `payment.refund_reference_mismatch\0${tenantId}\0${intentId.toLowerCase()}\0${providerRefundId ?? webhookEventId}`,
    )
    .digest("hex")
    .slice(0, 32);
  return uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

/**
 * legend-9s33i (1025 C): alerts the supervisors that a provider refund names
 * another intent than the one owning its payment id. Nothing was refunded or
 * stamped; the intent is held (`refund_recon_holds`) until finance matches the
 * refund. Sent only by the winner of the hold insert. Same savepoint rule as
 * above.
 */
export async function alertRefundReferenceMismatch(
  tx: Tx,
  context: ScopedTenantContext,
  held: RefundReferenceMismatchAlert,
  webhookEventId: string,
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const id = refundReferenceMismatchAlertId(
    tenantId,
    held.intentId,
    held.providerRefundId,
    webhookEventId,
  );
  try {
    await tx.transaction(async (savepoint) => {
      await notifyOutletSupervisors(
        savepoint,
        context,
        {
          tenantId,
          outletId: outletIdSchema.parse(held.outletId),
          category: "operational_anomaly",
          alsoOwners: true,
          recordEmpty: true,
          id,
          eventName: "payment.refund_reference_mismatch",
          aggregateType: "payment",
          aggregateId: id,
          payload: {
            intentId: held.intentId,
            amountIdr: String(held.amountIdr),
          },
          title: "Refund penyedia tidak cocok dengan pembayaran",
          body: `Penyedia pembayaran melaporkan refund Rp ${held.amountIdr.toLocaleString("id-ID")} yang menyebut pembayaran lain dari pembayaran yang dikembalikan. Uang mungkin sudah kembali ke pembayar. Refund dan payout pembayaran ini ditahan sampai finance mencocokkannya; tidak ada refund atau jurnal yang dibuat otomatis.`,
        },
        now,
      );
    });
  } catch (err) {
    logger.warn(
      { err, tenantId, intentId: held.intentId },
      "Refund reference mismatch: notification failed",
    );
  }
}

export type ProviderRefundCountedWithLiveOwn = {
  intentId: string;
  /** The outlet whose supervisors are told too; null: the owners only. */
  outletId: string | null;
  providerRefundId: string;
  amountIdr: number;
};

/**
 * legend-gjt5q (1025 B): the full provider refund was booked counting a refund
 * of OURS that was still in flight (not final). If that refund later fails the
 * journal is short, so the intent is held (`refund_recon_holds`) and finance
 * (the owners: a tenant-wide alert) must check it. Sent only by the winner of
 * the hold insert. Same savepoint rule as above.
 */
export async function alertProviderRefundCountedWithLiveOwn(
  tx: Tx,
  context: ScopedTenantContext,
  held: ProviderRefundCountedWithLiveOwn,
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const hex = createHash("sha256")
    .update(
      `payment.provider_refund_live_own\0${tenantId}\0${held.intentId.toLowerCase()}\0${held.providerRefundId}`,
    )
    .digest("hex")
    .slice(0, 32);
  const id = uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
  try {
    await tx.transaction(async (savepoint) => {
      await notifyOutletSupervisors(
        savepoint,
        context,
        {
          tenantId,
          outletId: held.outletId ? outletIdSchema.parse(held.outletId) : null,
          category: "operational_anomaly",
          alsoOwners: true,
          recordEmpty: true,
          id,
          eventName: "payment.provider_refund_live_own",
          aggregateType: "payment",
          aggregateId: id,
          payload: {
            intentId: held.intentId,
            amountIdr: String(held.amountIdr),
          },
          title:
            "Refund penyedia dibukukan bersama refund kami yang belum final",
          body: `Penyedia pembayaran mengembalikan seluruh pembayaran, dan Rp ${held.amountIdr.toLocaleString("id-ID")} dibukukan dengan menghitung refund kami yang belum selesai. Bila refund kami gagal, jurnal kurang. Refund dan payout pembayaran ini ditahan sampai finance memeriksanya.`,
        },
        now,
      );
    });
  } catch (err) {
    logger.warn(
      { err, tenantId, intentId: held.intentId },
      "Provider refund counted with live own refund: notification failed",
    );
  }
}

/** A recon hold filed by the system that finance must check; one alert per
 * hold (the id is derived from `dedupKey`). */
export type ReconHoldFiledAlert = {
  intentId: string;
  /** The outlet whose supervisors are told too; null: the owners only. */
  outletId: string | null;
  /** Stable per hold (same input, same alert id). */
  dedupKey: string;
  amountIdr: number;
  /** 1144 (SO ronde 16 P2-1): one provider refund report is ONE alert, whatever
   * the alert type (switched off, unmatched) and the retry that sends it. With
   * this set the alert id is derived from tenant, integration, intent and
   * refund id only (not from the event name, `dedupKey` or the amount); the
   * first alert of the report wins, later ones are swallowed by the dedupe. */
  stableRefund?: { integrationId: string | null; refundId: string };
};

/** The stable alert id (ULID) of a recon hold alert. Pure: same input, same
 * id; the tenant is always part of it. */
export function reconHoldAlertId(
  tenantId: string,
  eventName: string,
  held: Pick<ReconHoldFiledAlert, "intentId" | "dedupKey" | "stableRefund">,
): string {
  const hex = createHash("sha256")
    .update(
      held.stableRefund
        ? `payment.provider_refund_report\0${tenantId}\0${held.stableRefund.integrationId ?? ""}\0${held.intentId.toLowerCase()}\0${held.stableRefund.refundId}`
        : `${eventName}\0${tenantId}\0${held.intentId.toLowerCase()}\0${held.dedupKey}`,
    )
    .digest("hex")
    .slice(0, 32);
  return uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

async function alertReconHoldFiled(
  tx: Tx,
  context: ScopedTenantContext,
  held: ReconHoldFiledAlert,
  message: { eventName: string; title: string; body: string },
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const id = reconHoldAlertId(tenantId, message.eventName, held);
  try {
    await tx.transaction(async (savepoint) => {
      await notifyOutletSupervisors(
        savepoint,
        context,
        {
          tenantId,
          outletId: held.outletId ? outletIdSchema.parse(held.outletId) : null,
          category: "operational_anomaly",
          alsoOwners: true,
          recordEmpty: true,
          id,
          eventName: message.eventName,
          aggregateType: "payment",
          aggregateId: id,
          payload: {
            intentId: held.intentId,
            amountIdr: String(held.amountIdr),
          },
          title: message.title,
          body: message.body,
        },
        now,
      );
    });
  } catch (err) {
    logger.warn(
      { err, tenantId, intentId: held.intentId, eventName: message.eventName },
      "Refund recon hold: notification failed",
    );
  }
}

/**
 * 1045 A3: a refund of ours that may have reached the provider ended failed
 * and the intent is held (`own_refund_failed_unverified`). Same category and
 * audience as the live-own hold; sent only by the winner of the hold insert.
 */
export async function alertOwnRefundFailedUnverified(
  tx: Tx,
  context: ScopedTenantContext,
  held: ReconHoldFiledAlert,
  now: Date,
): Promise<void> {
  await alertReconHoldFiled(
    tx,
    context,
    held,
    {
      eventName: "payment.own_refund_failed_unverified",
      title: "Refund kami gagal setelah mungkin sampai ke penyedia",
      body: `Refund Rp ${held.amountIdr.toLocaleString("id-ID")} gagal setelah mungkin sudah sampai ke penyedia pembayaran. Uang mungkin sudah kembali ke pembayar. Refund dan payout pembayaran ini ditahan sampai finance memeriksanya di dashboard penyedia.`,
    },
    now,
  );
}

/**
 * 1191 (legend-rdg29): the `own_refund_failed_unverified` hold is still open.
 * Finance is reminded again, at most once per calendar day (`dayKey`, the
 * Jakarta date): the alert id is derived from the hold and the day, so a
 * second poller pass of the same day is swallowed by the notification dedupe.
 * The hold itself is never touched.
 */
export async function alertOwnRefundFailedStillOpen(
  tx: Tx,
  context: ScopedTenantContext,
  held: ReconHoldFiledAlert & { holdId: string; dayKey: string },
  now: Date,
): Promise<void> {
  await alertReconHoldFiled(
    tx,
    context,
    { ...held, dedupKey: `${held.holdId}:${held.dayKey}` },
    {
      eventName: "payment.own_refund_failed_still_open",
      title: "Refund kami yang gagal masih menunggu pemeriksaan",
      body: `Refund Rp ${held.amountIdr.toLocaleString("id-ID")} gagal setelah mungkin sudah sampai ke penyedia pembayaran, dan belum ditutup finance. Refund dan payout pembayaran ini tetap ditahan. Periksa di dashboard penyedia, lalu tutup penahanannya.`,
    },
    now,
  );
}

/**
 * 1045 A2: the provider reports a refund larger than what is left of the
 * transaction after the refunds already booked. Nothing is booked; the intent
 * is held and finance told once (winner of the hold insert).
 */
export async function alertProviderRefundExceedsLeft(
  tx: Tx,
  context: ScopedTenantContext,
  held: ReconHoldFiledAlert,
  now: Date,
): Promise<void> {
  await alertReconHoldFiled(
    tx,
    context,
    held,
    {
      eventName: "payment.provider_refund_exceeds_left",
      title: "Refund penyedia melebihi sisa pembayaran",
      body: `Penyedia pembayaran melaporkan refund Rp ${held.amountIdr.toLocaleString("id-ID")}, lebih dari sisa pembayaran setelah refund yang sudah dibukukan. Tidak ada yang dibukukan otomatis. Refund dan payout pembayaran ini ditahan sampai finance memeriksanya.`,
    },
    now,
  );
}

/**
 * 1055 G1: the provider reports a refund id on a transaction that already has
 * a refund finance counted from a hold without a refund id: it may be that
 * same refund. Nothing is booked; the intent is held and finance told once
 * (winner of the hold insert).
 */
export async function alertProviderRefundMayDuplicateAnonymous(
  tx: Tx,
  context: ScopedTenantContext,
  held: ReconHoldFiledAlert,
  now: Date,
): Promise<void> {
  await alertReconHoldFiled(
    tx,
    context,
    held,
    {
      eventName: "payment.provider_refund_may_duplicate_anonymous",
      title: "Refund penyedia mungkin sudah dihitung",
      body: `Penyedia pembayaran melaporkan refund Rp ${held.amountIdr.toLocaleString("id-ID")}. Pembayaran ini sudah punya refund tanpa nomor yang dihitung finance, jadi laporan ini mungkin refund yang sama. Tidak ada yang dibukukan otomatis. Refund dan payout pembayaran ini ditahan sampai finance memeriksanya.`,
    },
    now,
  );
}

/**
 * 1055 G2 (AP2-2): the provider reports a refund id on one transaction that is
 * already on record for another one. Nothing is booked; the intent is held and
 * finance told once (winner of the hold insert).
 */
export async function alertProviderRefundTransactionConflict(
  tx: Tx,
  context: ScopedTenantContext,
  held: ReconHoldFiledAlert,
  now: Date,
): Promise<void> {
  await alertReconHoldFiled(
    tx,
    context,
    held,
    {
      eventName: "payment.provider_refund_transaction_conflict",
      title: "Nomor refund penyedia tercatat di transaksi lain",
      body: `Penyedia pembayaran melaporkan refund Rp ${held.amountIdr.toLocaleString("id-ID")} dengan nomor refund yang sudah tercatat di transaksi lain. Tidak ada yang dibukukan otomatis. Refund dan payout pembayaran ini ditahan sampai finance memeriksanya.`,
    },
    now,
  );
}

/**
 * 1112: the DOIT refund switch is off (release 1), so a provider refund event
 * is held without being booked (CONFLICT hold from `holdSwitchedOffRefundSuccess`).
 * Own text: the event is not a refund id that sits on another transaction.
 */
export async function alertProviderRefundSwitchedOff(
  tx: Tx,
  context: ScopedTenantContext,
  held: ReconHoldFiledAlert,
  now: Date,
): Promise<void> {
  await alertReconHoldFiled(
    tx,
    context,
    held,
    {
      eventName: "payment.provider_refund_switched_off",
      title: "Refund penyedia ditahan, refund otomatis belum aktif",
      body: `Penyedia pembayaran melaporkan refund Rp ${held.amountIdr.toLocaleString("id-ID")}. Refund otomatis belum aktif, jadi laporan ini tidak dibukukan. Refund dan payout pembayaran ini ditahan sampai finance memeriksanya.`,
    },
    now,
  );
}

/**
 * 1126: a signed provider refund success matches no refund of Legend (a refund
 * made in the provider's dashboard, or a flat success without a refund id) but
 * names a Legend payment. It is held (CONFLICT hold, `holdSwitchedOffRefundSuccess`
 * with variant `unmatched`) until finance matches it. Own text: the switch may
 * be on, so the "automatic refunds not active" text of the switched-off alert
 * would be wrong. Sent only by the winner of the hold insert.
 */
export async function alertProviderRefundUnmatched(
  tx: Tx,
  context: ScopedTenantContext,
  held: ReconHoldFiledAlert,
  now: Date,
): Promise<void> {
  await alertReconHoldFiled(
    tx,
    context,
    held,
    {
      eventName: "payment.provider_refund_unmatched",
      title: "Refund penyedia tidak cocok dengan refund Legend",
      body: `Penyedia pembayaran melaporkan refund Rp ${held.amountIdr.toLocaleString("id-ID")} yang tidak cocok dengan refund Legend mana pun. Uang mungkin sudah kembali ke pembayar. Laporan ini tidak dibukukan otomatis. Refund dan payout pembayaran ini ditahan di antrean finance sampai finance memeriksanya di dashboard penyedia.`,
    },
    now,
  );
}

export type ProviderRefundUnmatchedUnmapped = {
  /** The stored webhook event: the alert is one per event. */
  webhookEventId: string;
};

/**
 * 1126: a signed provider refund success matches no refund of Legend and names
 * no payment Legend can map to a single payment. No hold is possible (no
 * intent to hold), so finance (the owners: a tenant-wide alert) is told once
 * per stored event. Same savepoint rule as above.
 */
export async function alertProviderRefundUnmatchedUnmapped(
  tx: Tx,
  context: ScopedTenantContext,
  unmapped: ProviderRefundUnmatchedUnmapped,
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const hex = createHash("sha256")
    .update(
      `payment.provider_refund_unmatched_unmapped\0${tenantId}\0${unmapped.webhookEventId}`,
    )
    .digest("hex")
    .slice(0, 32);
  const id = uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
  try {
    await tx.transaction(async (savepoint) => {
      await notifyOutletSupervisors(
        savepoint,
        context,
        {
          tenantId,
          outletId: null,
          category: "operational_anomaly",
          alsoOwners: true,
          recordEmpty: true,
          id,
          eventName: "payment.provider_refund_unmatched_unmapped",
          aggregateType: "payment",
          aggregateId: id,
          payload: { webhookEventId: unmapped.webhookEventId },
          title: "Refund penyedia tidak bisa dikaitkan ke pembayaran",
          body: "Penyedia pembayaran melaporkan refund yang tidak cocok dengan refund Legend dan tidak menyebut pembayaran yang bisa dikenali. Tidak ada yang ditahan atau dibukukan otomatis. Finance harus memeriksa dashboard penyedia: uang mungkin sudah kembali ke pembayar.",
        },
        now,
      );
    });
  } catch (err) {
    logger.warn(
      { err, tenantId, webhookEventId: unmapped.webhookEventId },
      "Provider refund unmatched (unmapped payment): notification failed",
    );
  }
}

export type ProviderRefundUnbound = {
  intentId: string;
  outletId: string;
  providerPaymentRef: string;
};

/**
 * legend-hpwpt (1025d): the provider says a transaction of the intent is
 * refunded but the recorder could not write it (`unbound`), so no fact and no
 * journal event exist. Never silent: finance (owners and the outlet's
 * supervisors) is told once per (tenant, intent, transaction); the stamp the
 * caller wrote stays. Same savepoint rule as above.
 */
export async function alertProviderRefundUnbound(
  tx: Tx,
  context: ScopedTenantContext,
  unbound: ProviderRefundUnbound,
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const hex = createHash("sha256")
    .update(
      `payment.provider_refund_unbound\0${tenantId}\0${unbound.intentId.toLowerCase()}\0${unbound.providerPaymentRef}`,
    )
    .digest("hex")
    .slice(0, 32);
  const id = uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
  try {
    await tx.transaction(async (savepoint) => {
      await notifyOutletSupervisors(
        savepoint,
        context,
        {
          tenantId,
          outletId: outletIdSchema.parse(unbound.outletId),
          category: "operational_anomaly",
          alsoOwners: true,
          recordEmpty: true,
          id,
          eventName: "payment.provider_refund_unbound",
          aggregateType: "payment",
          aggregateId: id,
          payload: { intentId: unbound.intentId },
          title: "Refund penyedia tidak bisa dibukukan",
          body: "Penyedia pembayaran menyatakan sebuah transaksi sudah dikembalikan, tetapi refund itu tidak bisa dicatat otomatis dan tidak ada jurnalnya. Dana transaksi itu tetap ditandai; finance harus memeriksa dan membukukannya.",
        },
        now,
      );
    });
  } catch (err) {
    logger.warn(
      { err, tenantId, intentId: unbound.intentId },
      "Provider refund unbound: notification failed",
    );
  }
}

export type CreditUsedBeforeProviderRefund = {
  intentId: string;
  outletId: string;
  providerRefundId: string;
  /** Credit used beyond what the DP still holds after the refund. */
  amountIdr: number;
};

/**
 * legend-ua9ja (1025c B): the provider refunded a DP after its transferred
 * credit was already used, beyond what is left of the DP. The intent is held
 * (`refund_recon_holds`) until finance decides; nothing used is cut. Sent only
 * by the winner of the hold insert. Same savepoint rule as above.
 */
export async function alertCreditUsedBeforeProviderRefund(
  tx: Tx,
  context: ScopedTenantContext,
  held: CreditUsedBeforeProviderRefund,
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const hex = createHash("sha256")
    .update(
      `payment.credit_used_before_provider_refund\0${tenantId}\0${held.intentId.toLowerCase()}\0${held.providerRefundId}`,
    )
    .digest("hex")
    .slice(0, 32);
  const id = uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
  try {
    await tx.transaction(async (savepoint) => {
      await notifyOutletSupervisors(
        savepoint,
        context,
        {
          tenantId,
          outletId: outletIdSchema.parse(held.outletId),
          category: "operational_anomaly",
          alsoOwners: true,
          recordEmpty: true,
          id,
          eventName: "payment.credit_used_before_provider_refund",
          aggregateType: "payment",
          aggregateId: id,
          payload: {
            intentId: held.intentId,
            amountIdr: String(held.amountIdr),
          },
          title: "Saldo DP sudah terpakai sebelum refund penyedia",
          body: `Penyedia pembayaran mengembalikan DP setelah saldo pelanggan dari DP itu dipakai. Rp ${held.amountIdr.toLocaleString("id-ID")} saldo terpakai melebihi sisa DP. Saldo yang sudah terpakai tidak dipotong. Refund dan payout pembayaran ini ditahan sampai finance memutuskan.`,
        },
        now,
      );
    });
  } catch (err) {
    logger.warn(
      { err, tenantId, intentId: held.intentId },
      "Credit used before provider refund: notification failed",
    );
  }
}
