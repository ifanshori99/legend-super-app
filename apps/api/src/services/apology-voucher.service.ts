// Apology vouchers for a failed item or a complaint (PRD v1.7 §3 "Voucher
// Permintaan Maaf"; ORD-08; bead legend-4qu; contract @starter/shared/qr-order
// `issueApologyVoucher` + `getApologyVoucher`).
//
// - An apology voucher is a CRM `vouchers` row (source `apology`, value voucher
//   without promotion, so the existing redeem path accepts it) plus an
//   append-only `apology_vouchers` row that records why, for whom and under
//   which approval it was issued.
// - The plain code is never stored. The CRM row keeps the SHA-256 digest; the
//   code is sealed (AES-GCM, AAD = tenant + voucher id) on `apology_vouchers`
//   so the guest can read it again in the order-issue list. The displayed code
//   is `LEG-XXXX-XXXX` (contract voucherCodeSchema); the digest is taken over
//   the code without hyphens because the CRM digest accepts only 6-32 letters
//   and digits.
// - `mintApologyVoucher` checks no permission: the caller (staff service or the
//   order-recovery service acting for the system) has already decided. It is
//   idempotent per order issue: a replay returns the stored voucher.
// - `issueApologyVoucherForStaff` checks `order.apology_voucher.issue` on the
//   outlet and applies the approval matrix (`apology_voucher`): a value at or
//   above a tier needs an approved request (409 APPROVAL_REQUIRED, the request
//   is opened and kept). A tenant without a policy fails closed. An optional
//   `Idempotency-Key` makes a double click return the same voucher (promo
//   idempotency table); another request under the same key is a 409.

import { createHash, randomInt } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  assertOutletInScope,
  CoreError,
  createUlid,
  idr,
  outletIdSchema,
  toIsoDateTime,
  userIdSchema,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
  type z,
} from "@starter/shared/core";
import {
  apologyVoucherSchema,
  qrOrderEvents,
  type ApologyVoucher,
  type createApologyVoucherInputSchema,
} from "@starter/shared/qr-order";
import { db } from "../db/index.ts";
import { promoCommandIdempotency, vouchers } from "../db/schema/crm-promo.ts";
import { apologyVouchers } from "../db/schema/apology-vouchers.ts";
import { domainEventOutbox } from "../db/schema/index.ts";
import { orderIssues } from "../db/schema/kds-issues.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { openSecret, sealSecret } from "../lib/secrets.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import { appendPromoEvent, hashPromoCode } from "./crm-promo-engine.ts";
import { promoIdempotentCommand } from "./crm-promo-idempotency.ts";
import type { Tx } from "./menu-internals.ts";
import { assertLineNotManuallyRefunded } from "./order-issue-manual-refund.ts";
import { voucherRoomIdr } from "./order-voucher-room.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";
import { openApprovalRequest } from "./platform-approval.service.ts";

export type CreateApologyVoucherInput = z.output<
  typeof createApologyVoucherInputSchema
>;

export type MintApologyVoucherInput = {
  outletId: string;
  issuedBy: string;
  valueIdr: number;
  reason: string;
  orderIssueId: string | null;
  customerProfileId: string | null;
  approvalRequestId: string | null;
  expiresInDays: number;
  now: Date;
};

export type MintedApologyVoucher = {
  apologyVoucherId: string;
  voucherId: string;
  code: string;
  expiresAt: Date;
  replayed: boolean;
};

const ISSUE = "order.apology_voucher.issue";
const RECOVERY = "order.recovery.handle";
const APPROVAL_MODULE = "apology_voucher";
/** Dead (rejected, expired, cancelled) requests skipped before refusing a swap credit. */
const MAX_DEAD_APPROVALS = 10;
const EVENT_DESTINATION = "cloud-sync";
const APPROVAL_ONCE_INDEX = "apology_vouchers_approval_once_idx";
const DAY_MS = 24 * 60 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_PREFIX = "LEG";
const CODE_GROUP_LENGTH = 4;
const CODE_ATTEMPTS = 5;
const AUDIT_SAFE_FIELDS = [
  "id",
  "voucherId",
  "orderIssueId",
  "valueIdr",
  "approvalRequestId",
];

const deniedIssue = () =>
  new AccessError(
    "PERMISSION_DENIED",
    "Anda tidak dapat menerbitkan voucher maaf di outlet ini.",
  );
const voucherNotFound = () =>
  new CoreError("NOT_FOUND", "Voucher maaf tidak ditemukan.");
const issueNotFound = () =>
  new CoreError("NOT_FOUND", "Laporan item gagal tidak ditemukan.");
const unprocessable = (message: string) =>
  new HttpError(422, "VALIDATION_ERROR", message);

export const approvalRequiredMessage = (requestId: string) =>
  `Voucher maaf bernilai ini butuh persetujuan. Permintaan approval: ${requestId}.`;

type ApologyRow = typeof apologyVouchers.$inferSelect;
type VoucherRow = typeof vouchers.$inferSelect;

function codeGroup(): string {
  let group = "";
  for (let index = 0; index < CODE_GROUP_LENGTH; index += 1)
    group += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return group;
}

function newApologyCode(): string {
  return `${CODE_PREFIX}-${codeGroup()}-${codeGroup()}`;
}

/** Digest of a displayed or typed code: uppercase, without hyphens or spaces. */
function digestOf(code: string): string {
  return hashPromoCode(code.trim().toUpperCase().replaceAll("-", ""));
}

/** AAD of a sealed apology code: tenant id + the CRM `vouchers` row id. */
export const sealAad = (tenantId: string, voucherId: string) =>
  `apology-voucher:${tenantId}:${voucherId}`;

/** Name of the violated unique constraint, directly or in drizzle's cause chain; null when none. */
function uniqueViolationOf(error: unknown, depth = 0): string | null {
  if (depth > 4 || typeof error !== "object" || error === null) return null;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  if (candidate.code === "23505")
    return typeof candidate.constraint === "string" ? candidate.constraint : "";
  return uniqueViolationOf(candidate.cause, depth + 1);
}

const approvalAlreadyUsed = () =>
  new HttpError(
    409,
    "APPROVAL_ALREADY_USED",
    "Approval ini sudah dipakai untuk voucher maaf lain.",
  );

async function storedForIssue(
  tx: Tx,
  tenantId: TenantId,
  orderIssueId: string,
): Promise<{ apology: ApologyRow; voucher: VoucherRow } | null> {
  const [row] = await tx
    .select({ apology: apologyVouchers, voucher: vouchers })
    .from(apologyVouchers)
    .innerJoin(
      vouchers,
      and(
        eq(vouchers.tenantId, apologyVouchers.tenantId),
        eq(vouchers.id, apologyVouchers.voucherId),
      ),
    )
    .where(
      and(
        eq(apologyVouchers.tenantId, tenantId),
        eq(apologyVouchers.orderIssueId, orderIssueId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** A replay returns the stored voucher; another value is a conflict, never silently the old one. */
function replayOf(
  tenantId: TenantId,
  stored: { apology: ApologyRow; voucher: VoucherRow },
  valueIdr: number,
): MintedApologyVoucher {
  const { apology, voucher } = stored;
  if (voucher.valueIdr !== valueIdr)
    throw new CoreError(
      "CONFLICT",
      "Laporan ini sudah punya voucher maaf dengan nilai berbeda.",
    );
  return {
    apologyVoucherId: apology.id,
    voucherId: voucher.id,
    code: openSecret(apology.codeSealed, sealAad(tenantId, voucher.id)),
    expiresAt: expiryOf(voucher),
    replayed: true,
  };
}

function expiryOf(voucher: VoucherRow): Date {
  // An apology voucher always carries an end date; the fallback only guards a
  // row written by another path.
  return (
    voucher.validUntil ?? new Date(voucher.issuedAt.getTime() + 30 * DAY_MS)
  );
}

/**
 * Inserts the CRM voucher and its apology record in the caller's transaction.
 * No permission check (the caller decided). Idempotent per `orderIssueId`.
 */
export async function mintApologyVoucher(
  tx: Tx,
  context: ScopedTenantContext,
  input: MintApologyVoucherInput,
): Promise<MintedApologyVoucher> {
  const tenantId = context.tenant.tenantId;
  const outletId = outletIdSchema.parse(input.outletId);
  const issuedBy = userIdSchema.parse(input.issuedBy);
  assertOutletInScope(context.outletScope, outletId);
  if (!Number.isInteger(input.valueIdr) || input.valueIdr <= 0)
    throw unprocessable("Nilai voucher maaf harus lebih dari nol.");
  const reason = input.reason.trim();
  if (reason.length < 10)
    throw unprocessable("Alasan voucher maaf minimal 10 karakter.");

  if (input.orderIssueId !== null) {
    const stored = await storedForIssue(tx, tenantId, input.orderIssueId);
    if (stored) return replayOf(tenantId, stored, input.valueIdr);
  }

  const expiresAt = new Date(
    input.now.getTime() + input.expiresInDays * DAY_MS,
  );
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const code = newApologyCode();
    try {
      // A savepoint keeps a code collision or a lost race from aborting the
      // surrounding transaction.
      const minted = await tx.transaction(async (savepoint) => {
        const [voucher] = await savepoint
          .insert(vouchers)
          .values({
            tenantId,
            promotionId: null,
            customerProfileId: input.customerProfileId,
            codeHash: digestOf(code),
            source: "apology",
            status: "issued",
            valueIdr: idr(input.valueIdr),
            validFrom: input.now,
            validUntil: expiresAt,
            issuedAt: input.now,
            issuedBy,
          })
          .returning();
        if (!voucher) throw new Error("Voucher insert returned no row");
        const [apology] = await savepoint
          .insert(apologyVouchers)
          .values({
            tenantId,
            outletId,
            voucherId: voucher.id,
            orderIssueId: input.orderIssueId,
            reason,
            approvalRequestId: input.approvalRequestId,
            codeSealed: sealSecret(code, sealAad(tenantId, voucher.id)),
            customerProfileId: input.customerProfileId,
            issuedBy,
            issuedAt: input.now,
          })
          .returning();
        if (!apology) throw new Error("Apology voucher insert returned no row");
        return { voucher, apology };
      });

      await appendPromoEvent(tx, context, "voucher.issued", {
        aggregateId: minted.voucher.id,
        aggregateUuid: minted.voucher.id,
        outletId,
        actorUserId: issuedBy,
        idempotencyKey: `voucher.issued:${minted.voucher.id}`,
        now: input.now,
        payload: {
          voucherId: minted.voucher.id,
          promotionId: null,
          customerProfileId: input.customerProfileId,
          source: "apology",
          valueIdr: input.valueIdr,
          validFrom: toIsoDateTime(input.now),
          validUntil: toIsoDateTime(expiresAt),
        },
      });
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(input.now.getTime()),
          tenantId,
          outletId,
          actorType: "user",
          actorId: issuedBy,
          deviceId: null,
          action: "apology_voucher.issued",
          objectType: "apology_voucher",
          objectId: minted.apology.id,
          reason,
          maskedChanges: {
            before: null,
            after: {
              id: minted.apology.id,
              voucherId: minted.voucher.id,
              orderIssueId: input.orderIssueId,
              valueIdr: input.valueIdr,
              approvalRequestId: input.approvalRequestId,
            },
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: toIsoDateTime(input.now),
        },
        AUDIT_SAFE_FIELDS,
      );
      return {
        apologyVoucherId: minted.apology.id,
        voucherId: minted.voucher.id,
        code,
        expiresAt,
        replayed: false,
      };
    } catch (error) {
      const violated = uniqueViolationOf(error);
      if (violated === null) throw error;
      if (violated === APPROVAL_ONCE_INDEX) throw approvalAlreadyUsed();
      // Lost the race for this order issue: return the winner's voucher.
      if (input.orderIssueId !== null) {
        const stored = await storedForIssue(tx, tenantId, input.orderIssueId);
        if (stored) return replayOf(tenantId, stored, input.valueIdr);
      }
      // Otherwise the code collided: draw another.
    }
  }
  throw new HttpError(
    503,
    "VOUCHER_CODE_UNAVAILABLE",
    "Kode voucher belum dapat dibuat. Coba lagi.",
  );
}

function toApologyVoucher(
  tenantId: TenantId,
  apology: ApologyRow,
  voucher: VoucherRow,
  code: string,
  now: Date,
): ApologyVoucher {
  const expiresAt = expiryOf(voucher);
  const status =
    voucher.status === "cancelled"
      ? "void"
      : voucher.status === "redeemed"
        ? "redeemed"
        : voucher.status === "expired" || expiresAt.getTime() <= now.getTime()
          ? "expired"
          : "issued";
  return apologyVoucherSchema.parse({
    id: apology.id,
    tenantId,
    outletId: apology.outletId,
    code,
    valueIdr: voucher.valueIdr,
    status,
    reason: apology.reason,
    orderIssueId: apology.orderIssueId,
    customerProfileId: apology.customerProfileId,
    issuedBy: apology.issuedBy,
    approvalRequestId: apology.approvalRequestId,
    issuedAt: toIsoDateTime(apology.issuedAt),
    expiresAt: toIsoDateTime(expiresAt),
    redeemedAt:
      status === "redeemed" && voucher.redeemedAt
        ? toIsoDateTime(voucher.redeemedAt)
        : null,
    redemptionOrderId:
      status === "redeemed" ? (voucher.redeemedOrderId ?? null) : null,
  });
}

/** The single outlet of the caller's scope, or null when it is not one. */
function soleOutlet(context: ScopedTenantContext): OutletId | null {
  const scope = context.outletScope;
  return scope.kind === "outlets" && scope.outletIds.length === 1
    ? (scope.outletIds[0] ?? null)
    : null;
}

type ApprovalCheck = {
  readonly objectType: string;
  readonly objectId: string;
  readonly valueIdr: number;
};

/** An approved, matching, not yet used approval chain (tenant-scoped by RLS and filter). */
async function assertApprovedRequest(
  tx: Tx,
  tenantId: TenantId,
  approvalRequestId: string,
  expected: ApprovalCheck,
  orderIssueId: string | null,
): Promise<{ decidedBy: string | null }> {
  const [row] = await tx
    .select({ chainId: approvalRequests.chainId })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.id, approvalRequestId),
      ),
    )
    .limit(1);
  if (!row)
    throw unprocessable("Permintaan approval voucher maaf tidak ditemukan.");
  const chain = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.chainId, row.chainId),
      ),
    )
    .orderBy(asc(approvalRequests.level));
  const last = chain.at(-1);
  if (!last || last.status !== "approved" || last.level < last.requiredLevels)
    throw unprocessable("Permintaan approval voucher maaf belum disetujui.");
  if (
    last.actionType !== "apology_voucher" ||
    last.objectType !== expected.objectType ||
    last.objectId !== expected.objectId ||
    last.amountIdr !== expected.valueIdr
  )
    throw unprocessable(
      "Permintaan approval tidak cocok dengan voucher maaf ini.",
    );
  const [used] = await tx
    .select({ orderIssueId: apologyVouchers.orderIssueId })
    .from(apologyVouchers)
    .where(
      and(
        eq(apologyVouchers.tenantId, tenantId),
        eq(apologyVouchers.approvalRequestId, approvalRequestId),
      ),
    )
    .limit(1);
  // The same approval may be replayed for the same order issue only.
  if (used && (orderIssueId === null || used.orderIssueId !== orderIssueId))
    throw approvalAlreadyUsed();
  return { decidedBy: last.decidedBy };
}

/** A chain that ended without approval (or lapsed past its deadline) can never be approved. */
async function approvalChainIsDead(
  tx: Tx,
  tenantId: TenantId,
  chainId: string,
  now: Date,
): Promise<boolean> {
  const [last] = await tx
    .select({
      status: approvalRequests.status,
      deadlineAt: approvalRequests.deadlineAt,
    })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.chainId, chainId),
      ),
    )
    .orderBy(desc(approvalRequests.level))
    .limit(1);
  if (!last) return false;
  if (last.status === "pending") return last.deadlineAt <= now;
  return (
    last.status === "rejected" ||
    last.status === "expired" ||
    last.status === "cancelled"
  );
}

export type SwapCreditApproval =
  | { kind: "pending"; requestId: string }
  | {
      kind: "clear";
      approvalRequestId: string | null;
      /** Last decider of the approved chain; null when no approval was needed. */
      approvedBy: string | null;
    };

/**
 * The `apology_voucher` matrix for the credit of a staff swap to a cheaper
 * menu (object = the order issue, value = the credit). With an approval id the
 * request must be approved, matching and unused by another issue. Without one
 * the request is opened (idempotent): `pending` means the caller must commit
 * and answer 409 APPROVAL_REQUIRED; `clear` with a null id means the credit is
 * under the threshold and needs none. A replayed request whose chain is
 * rejected, expired or cancelled is never returned: a new request is opened
 * under a key that also hashes the dead request ids.
 */
export async function requireSwapCreditApproval(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    orderIssueId: string;
    outletId: string;
    valueIdr: number;
    reason: string;
    requestedBy: string;
    approvalRequestId: string | undefined;
    now: Date;
  },
): Promise<SwapCreditApproval> {
  const tenantId = context.tenant.tenantId;
  if (input.approvalRequestId !== undefined) {
    const approved = await assertApprovedRequest(
      tx,
      tenantId,
      input.approvalRequestId,
      {
        objectType: "order_issue",
        objectId: input.orderIssueId,
        valueIdr: input.valueIdr,
      },
      input.orderIssueId,
    );
    return {
      kind: "clear",
      approvalRequestId: input.approvalRequestId,
      approvedBy: approved.decidedBy,
    };
  }
  const deadIds: string[] = [];
  for (let attempt = 0; attempt < MAX_DEAD_APPROVALS; attempt += 1) {
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          "order_issue",
          input.orderIssueId,
          input.valueIdr,
          input.reason,
          ...deadIds,
        ]),
      )
      .digest("hex")
      .slice(0, 40);
    const opened = await openApprovalRequest(tx, context, {
      sourceModule: APPROVAL_MODULE,
      actionType: "apology_voucher",
      objectType: "order_issue",
      objectId: input.orderIssueId,
      amountIdr: input.valueIdr,
      outletId: outletIdSchema.parse(input.outletId),
      requestedBy: userIdSchema.parse(input.requestedBy),
      source: "user",
      requestReason: input.reason,
      payload: {
        valueIdr: input.valueIdr,
        orderIssueId: input.orderIssueId,
        customerProfileId: null,
      },
      idempotencyKey: `apology:${digest}`,
      now: input.now,
    });
    if (!opened.required)
      return { kind: "clear", approvalRequestId: null, approvedBy: null };
    if (!(await approvalChainIsDead(tx, tenantId, opened.chainId, input.now)))
      return { kind: "pending", requestId: opened.request.id };
    deadIds.push(opened.request.id);
  }
  throw unprocessable(
    "Terlalu banyak permintaan approval kredit yang ditolak atau kedaluwarsa untuk laporan ini; hubungi pengelola.",
  );
}

type IssueLock = {
  outletId: string;
  orderId: string;
  orderItemId: string;
  status: string;
};

async function nextSequence(
  tx: Tx,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, aggregateType),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/**
 * Staff issued the voucher for an open failed-item issue: the issue is settled
 * as `voucher` in the same transaction. `voucher_id` holds the apology voucher
 * id (`apology_vouchers.id`), the same value order-recovery stores.
 */
async function settleIssueWithVoucher(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    orderIssueId: string;
    issue: IssueLock;
    apologyVoucherId: string;
    actor: string;
    reason: string;
    now: Date;
  },
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const { issue, now } = input;
  // legend-980 (M1): a line with a live manual refund is paid back; a voucher
  // on top pays the guest twice. Takes the order row lock the refund takes.
  await assertLineNotManuallyRefunded(
    tx,
    tenantId,
    issue.orderId,
    issue.orderItemId,
  );
  const [row] = await tx
    .update(orderIssues)
    .set({
      resolution: "voucher",
      voucherId: input.apologyVoucherId,
      status: "resolved",
      resolvedAt: now,
    })
    .where(
      and(
        eq(orderIssues.tenantId, tenantId),
        eq(orderIssues.id, input.orderIssueId),
        eq(orderIssues.status, "open"),
      ),
    )
    .returning({ id: orderIssues.id });
  if (!row) throw new CoreError("CONFLICT", "Laporan ini sudah diselesaikan.");

  const definition = qrOrderEvents["order_issue.resolved"];
  const sequence = await nextSequence(
    tx,
    tenantId,
    definition.entry.aggregateType,
    input.orderIssueId,
  );
  const event = definition.envelopeSchema.parse({
    id: createUlid(now.getTime()),
    tenantId,
    outletId: issue.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.orderIssueId,
    sequence,
    occurredAt: toIsoDateTime(now),
    actor: { type: "user", id: input.actor },
    deviceId: null,
    idempotencyKey:
      `${definition.name}:${input.orderIssueId}:${sequence}`.slice(0, 100),
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: {
      orderId: issue.orderId,
      orderItemId: issue.orderItemId,
      orderIssueId: input.orderIssueId,
      resolution: "voucher",
      resolvedBy: "staff",
      replacementItemId: null,
      voucherId: input.apologyVoucherId,
      priceDifferenceIdr: null,
    },
  });
  await appendOutbox(tx, context, {
    id: createUlid(now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId,
      outletId: issue.outletId,
      actorType: "user",
      actorId: input.actor,
      deviceId: null,
      action: "order_issue.resolved.voucher",
      objectType: "order_issue",
      objectId: input.orderIssueId,
      reason: input.reason,
      maskedChanges: {
        before: null,
        after: {
          id: input.orderIssueId,
          resolution: "voucher",
          voucherId: input.apologyVoucherId,
        },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: toIsoDateTime(now),
    },
    AUDIT_SAFE_FIELDS,
  );
}

type StaffIssueOutcome =
  | { kind: "issued"; voucher: ApologyVoucher }
  | { kind: "approval"; requestId: string };

/** Replay of a stored issue: same outlet permission as a new issue, current voucher status. */
async function freshReplay(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  stored: ApologyVoucher,
  now: Date,
): Promise<ApologyVoucher> {
  const tenantId = context.tenant.tenantId;
  const outletId = outletIdSchema.parse(stored.outletId);
  try {
    assertOutletInScope(context.outletScope, outletId);
  } catch {
    throw deniedIssue();
  }
  const snapshot = await accessSnapshotInTransaction(tx, context, actor, now);
  if (!snapshot.allows(ISSUE, { type: "outlet", id: outletId }))
    throw deniedIssue();
  const [row] = await tx
    .select({ apology: apologyVouchers, voucher: vouchers })
    .from(apologyVouchers)
    .innerJoin(
      vouchers,
      and(
        eq(vouchers.tenantId, apologyVouchers.tenantId),
        eq(vouchers.id, apologyVouchers.voucherId),
      ),
    )
    .where(
      and(
        eq(apologyVouchers.tenantId, tenantId),
        eq(apologyVouchers.id, stored.id),
      ),
    )
    .limit(1);
  if (!row) throw voucherNotFound();
  return toApologyVoucher(tenantId, row.apology, row.voucher, stored.code, now);
}

/**
 * Staff issue of an apology voucher: permission on the outlet, then the
 * approval matrix. Returns the voucher; throws 409 APPROVAL_REQUIRED (request
 * opened and kept) when the value needs an approval that is not yet given.
 */
export async function issueApologyVoucherForStaff(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateApologyVoucherInput,
  now: Date,
  idempotencyKey: string | null = null,
): Promise<ApologyVoucher> {
  const actor = userIdSchema.parse(actorUserId);
  const tenantId = context.tenant.tenantId;
  const issueInTransaction = async (tx: Tx): Promise<StaffIssueOutcome> => {
    let outletId: OutletId | null;
    let issue: IssueLock | null = null;
    if (input.orderIssueId !== undefined) {
      // Locked so two staff or a guest choice cannot settle the issue twice.
      const [found] = await tx
        .select({
          outletId: orderIssues.outletId,
          orderId: orderIssues.orderId,
          orderItemId: orderIssues.orderItemId,
          status: orderIssues.status,
        })
        .from(orderIssues)
        .where(
          and(
            eq(orderIssues.tenantId, tenantId),
            eq(orderIssues.id, input.orderIssueId),
          ),
        )
        .limit(1)
        .for("update");
      if (!found) throw issueNotFound();
      issue = found;
      outletId = outletIdSchema.parse(found.outletId);
      // Out of the caller's scope looks like a missing issue.
      try {
        assertOutletInScope(context.outletScope, outletId);
      } catch {
        throw issueNotFound();
      }
    } else {
      outletId = soleOutlet(context);
      if (outletId === null)
        throw unprocessable(
          "Outlet voucher maaf tidak jelas. Sertakan laporan item gagal.",
        );
    }

    const snapshot = await accessSnapshotInTransaction(tx, context, actor, now);
    if (!snapshot.allows(ISSUE, { type: "outlet", id: outletId }))
      throw deniedIssue();

    const orderIssueId = input.orderIssueId ?? null;
    const expected: ApprovalCheck =
      orderIssueId !== null
        ? {
            objectType: "order_issue",
            objectId: orderIssueId,
            valueIdr: input.valueIdr,
          }
        : {
            objectType: "outlet",
            objectId: outletId,
            valueIdr: input.valueIdr,
          };

    // An issue that already has its voucher replays before any approval work.
    if (orderIssueId !== null) {
      const stored = await storedForIssue(tx, tenantId, orderIssueId);
      if (stored) {
        const replay = replayOf(tenantId, stored, input.valueIdr);
        return {
          kind: "issued",
          voucher: toApologyVoucher(
            tenantId,
            stored.apology,
            stored.voucher,
            replay.code,
            now,
          ),
        };
      }
    }
    if (issue !== null && issue.status !== "open")
      throw new CoreError(
        "CONFLICT",
        "Laporan ini sudah diselesaikan atau dibatalkan.",
      );
    // legend-eajpb: the voucher of a failed-item report never takes the money
    // handed back past what the guest paid. Lock order: the issue lock above,
    // then this order lock (the one `assertLineNotManuallyRefunded` takes),
    // then the room is read under it. Refused, not cut: the value is what the
    // approval (and a replay) names.
    if (issue !== null && orderIssueId !== null) {
      await assertLineNotManuallyRefunded(
        tx,
        tenantId,
        issue.orderId,
        issue.orderItemId,
      );
      const roomIdr = await voucherRoomIdr(tx, context, {
        orderId: issue.orderId,
        orderItemId: issue.orderItemId,
      });
      if (roomIdr <= 0)
        throw new HttpError(
          422,
          "APOLOGY_VOUCHER_NOTHING_DUE",
          "Pesanan ini sudah tidak punya sisa dana yang bisa dijadikan voucher maaf.",
        );
      if (input.valueIdr > roomIdr)
        throw new HttpError(
          422,
          "APOLOGY_VOUCHER_OVER_ROOM",
          `Nilai voucher melebihi sisa dana pesanan ini, maks Rp${new Intl.NumberFormat("id-ID").format(roomIdr)}.`,
        );
    }

    let approvalRequestId: string | null = input.approvalRequestId ?? null;
    if (approvalRequestId !== null) {
      await assertApprovedRequest(
        tx,
        tenantId,
        approvalRequestId,
        expected,
        orderIssueId,
      );
    } else {
      const digest = createHash("sha256")
        .update(
          JSON.stringify([
            expected.objectType,
            expected.objectId,
            expected.valueIdr,
            input.reason,
          ]),
        )
        .digest("hex")
        .slice(0, 40);
      const opened = await openApprovalRequest(tx, context, {
        sourceModule: APPROVAL_MODULE,
        actionType: "apology_voucher",
        objectType: expected.objectType,
        objectId: expected.objectId,
        amountIdr: input.valueIdr,
        outletId,
        requestedBy: actor,
        source: "user",
        requestReason: input.reason,
        payload: {
          valueIdr: input.valueIdr,
          orderIssueId,
          customerProfileId: input.customerProfileId ?? null,
        },
        idempotencyKey: `apology:${digest}`,
        now,
      });
      if (opened.required)
        return { kind: "approval", requestId: opened.request.id };
      approvalRequestId = null;
    }

    const minted = await mintApologyVoucher(tx, context, {
      outletId,
      issuedBy: actor,
      valueIdr: input.valueIdr,
      reason: input.reason,
      orderIssueId,
      customerProfileId: input.customerProfileId ?? null,
      approvalRequestId,
      expiresInDays: input.expiresInDays,
      now,
    });
    if (issue !== null && orderIssueId !== null)
      await settleIssueWithVoucher(tx, context, {
        orderIssueId,
        issue,
        apologyVoucherId: minted.apologyVoucherId,
        actor,
        reason: input.reason,
        now,
      });
    const [row] = await tx
      .select({ apology: apologyVouchers, voucher: vouchers })
      .from(apologyVouchers)
      .innerJoin(
        vouchers,
        and(
          eq(vouchers.tenantId, apologyVouchers.tenantId),
          eq(vouchers.id, apologyVouchers.voucherId),
        ),
      )
      .where(
        and(
          eq(apologyVouchers.tenantId, tenantId),
          eq(apologyVouchers.id, minted.apologyVoucherId),
        ),
      )
      .limit(1);
    if (!row) throw new Error("Apology voucher vanished after insert");
    return {
      kind: "issued",
      voucher: toApologyVoucher(
        tenantId,
        row.apology,
        row.voucher,
        minted.code,
        now,
      ),
    };
  };
  // Same key + same request replays the first voucher; its plain code is kept
  // sealed in the stored response, never in the clear.
  const aad = `apology-voucher-idem:${tenantId}:${idempotencyKey}`;
  const outcome = await withTenant(db, context, async (tx) => {
    let ran = false;
    const result = await promoIdempotentCommand<StaffIssueOutcome>(
      tx,
      context,
      {
        key: idempotencyKey,
        operation: "apology_voucher.issue",
        request: { actor, input },
        encode: (stored) =>
          stored.kind === "issued"
            ? {
                kind: "issued",
                voucher: {
                  ...stored.voucher,
                  code: sealSecret(stored.voucher.code, aad),
                },
              }
            : stored,
        decode: (stored) => {
          const value = stored as StaffIssueOutcome;
          return value.kind === "issued"
            ? {
                kind: "issued",
                voucher: {
                  ...value.voucher,
                  code: openSecret(value.voucher.code, aad),
                },
              }
            : value;
        },
      },
      () => {
        ran = true;
        return issueInTransaction(tx);
      },
    );
    // A replay skipped the permission check and holds a stale status: check
    // the outlet again and read the voucher's current state.
    if (!ran && result.kind === "issued")
      return {
        kind: "issued",
        voucher: await freshReplay(tx, context, actor, result.voucher, now),
      } satisfies StaffIssueOutcome;
    // A pending approval is not a final answer: forget the key so the same
    // request can be sent again once the approval is granted.
    if (result.kind === "approval" && idempotencyKey !== null)
      await tx
        .delete(promoCommandIdempotency)
        .where(
          and(
            eq(promoCommandIdempotency.tenantId, tenantId),
            eq(promoCommandIdempotency.key, idempotencyKey),
          ),
        );
    return result;
  });
  if (outcome.kind === "approval")
    throw new HttpError(
      409,
      "APPROVAL_REQUIRED",
      approvalRequiredMessage(outcome.requestId),
    );
  return outcome.voucher;
}

/** Reads one apology voucher by its code (digest lookup; the code is never stored plain). */
export async function getApologyVoucherByCode(
  context: ScopedTenantContext,
  actorUserId: string,
  code: string,
  now: Date,
): Promise<ApologyVoucher> {
  const actor = userIdSchema.parse(actorUserId);
  const tenantId = context.tenant.tenantId;
  let digest: string;
  try {
    digest = digestOf(code);
  } catch {
    throw voucherNotFound();
  }
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({ apology: apologyVouchers, voucher: vouchers })
      .from(vouchers)
      .innerJoin(
        apologyVouchers,
        and(
          eq(apologyVouchers.tenantId, vouchers.tenantId),
          eq(apologyVouchers.voucherId, vouchers.id),
        ),
      )
      .where(
        and(eq(vouchers.tenantId, tenantId), eq(vouchers.codeHash, digest)),
      )
      .limit(1);
    if (!row) throw voucherNotFound();
    const outletId = outletIdSchema.parse(row.apology.outletId);
    // An outlet outside the caller's scope looks like a missing voucher.
    try {
      assertOutletInScope(context.outletScope, outletId);
    } catch {
      throw voucherNotFound();
    }
    const snapshot = await accessSnapshotInTransaction(tx, context, actor, now);
    const target = { type: "outlet", id: outletId } as const;
    if (!snapshot.allows(ISSUE, target) && !snapshot.allows(RECOVERY, target))
      throw voucherNotFound();
    return toApologyVoucher(
      tenantId,
      row.apology,
      row.voucher,
      openSecret(row.apology.codeSealed, sealAad(tenantId, row.voucher.id)),
      now,
    );
  });
}
