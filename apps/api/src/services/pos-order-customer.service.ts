// Attach a member to an unpaid POS order (legend-111j, docs/design/
// ws08-member-loyalty.md §M6): by the member's rotating QR token, by a
// cashier phone lookup (capped per cashier per business day), or detach.
// The earn consumer reads `orders.customer_profile_id` and
// `customer_attached_by` after payment; a database trigger freezes the
// profile once the order is completed.
//
// Phone lookups are the abuse path (a cashier could attach any registered
// number), so every lookup writes a `phone_lookup_attach` anomaly, including
// a number that matches no active member (details carry the outcome, never
// the number). That also caps number probing. The cap check, the anomaly
// rows and the refusal are committed before the error is thrown, so a
// refused request still leaves its audit trail.

import { and, eq, ne, sql } from "drizzle-orm";
import {
  createUlid,
  type ScopedTenantContext,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import { DELIVERY_PLATFORMS } from "@starter/shared/delivery";
import type {
  OrderCustomerAttachVia,
  OrderCustomerSummary,
  SetOrderCustomerInput,
} from "@starter/shared/crm";
import { db } from "../db";
import { customerProfiles, loyaltyPrograms } from "../db/schema/crm-member";
import { posOrders, posOrderTenders } from "../db/schema/pos-order";
import { orders, type OrderStatus } from "../db/schema/qr-order";
import { memberTenantContext } from "../db/member-scope";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { whatsAppDigest } from "../lib/identity-digest";
import { verifyMemberQrToken } from "../lib/member-qr-token";
import { recordAudit } from "./core-audit";
import { crmHttpError } from "./crm-promo-engine";
import {
  countPhoneLookups,
  recordLoyaltyAnomaly,
} from "./loyalty-anomaly.service";

/** Cashier phone lookups per business day when the tenant has no program row. */
const DEFAULT_PHONE_LOOKUP_DAILY_CAP = 20;
const ATTACHABLE_STATUSES: readonly OrderStatus[] = [
  "draft",
  "awaiting_payment",
  "sent",
];
const AUDIT_SAFE_FIELDS = ["via", "attached"] as const;

/**
 * Outlet of an order, for the route's outlet permission check (the contract
 * path carries no outlet). Read with a trusted tenant-wide scope; the tenant
 * comes from the server-minted context, so another tenant's order is never
 * found. Null when the order does not exist.
 */
export async function findPosOrderOutletId(
  tenantId: TenantId,
  orderId: string,
): Promise<string | null> {
  return withTenant(db, memberTenantContext(tenantId), async (tx) => {
    const [row] = await tx
      .select({ outletId: posOrders.outletId })
      .from(posOrders)
      .where(
        and(eq(posOrders.tenantId, tenantId), eq(posOrders.orderId, orderId)),
      )
      .limit(1);
    return row?.outletId ?? null;
  });
}

/** SQLSTATE 55000 with the named constraint, directly or in the cause chain. */
function isLockViolation(
  error: unknown,
  constraint: string,
  depth = 0,
): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  return (
    (candidate.code === "55000" && candidate.constraint === constraint) ||
    isLockViolation(candidate.cause, constraint, depth + 1)
  );
}

type Outcome =
  | { kind: "ok"; summary: OrderCustomerSummary }
  | { kind: "refused"; error: HttpError };

export async function setPosOrderCustomer(
  context: ScopedTenantContext,
  actorUserId: UserId,
  orderId: string,
  input: SetOrderCustomerInput,
  now = new Date(),
): Promise<OrderCustomerSummary> {
  const tenantId = context.tenant.tenantId;
  // Digest first: an unparseable number fails before any lock or write.
  let digest: string | null = null;
  if (input.whatsappNumber !== undefined) {
    try {
      digest = await whatsAppDigest(input.whatsappNumber);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Nomor WhatsApp tidak valid.",
      );
    }
  }

  const outcome = await withTenant(
    db,
    context,
    async (tx): Promise<Outcome> => {
      const [order] = await tx
        .select({
          id: orders.id,
          outletId: orders.outletId,
          status: orders.status,
          channel: orders.channel,
          businessDate: orders.businessDate,
          completedAt: posOrders.completedAt,
        })
        .from(orders)
        .innerJoin(
          posOrders,
          and(
            eq(posOrders.tenantId, orders.tenantId),
            eq(posOrders.orderId, orders.id),
          ),
        )
        .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
        .limit(1)
        .for("update", { of: orders });
      if (!order)
        throw new HttpError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
      // Delivery-platform orders are created `sent` and paid by the platform;
      // a member attached there would earn on a sale the cashier never rang.
      if (
        !ATTACHABLE_STATUSES.includes(order.status) ||
        order.completedAt ||
        (DELIVERY_PLATFORMS as readonly string[]).includes(order.channel)
      )
        throw new HttpError(
          409,
          "ORDER_NOT_UNPAID",
          "Pelanggan hanya bisa diubah sebelum pesanan dibayar.",
        );
      // 936: points already spent belong to this member; changing or removing
      // the member would leave them paid out of another account.
      const [pointsTender] = await tx
        .select({ id: posOrderTenders.id })
        .from(posOrderTenders)
        .where(
          and(
            eq(posOrderTenders.tenantId, tenantId),
            eq(posOrderTenders.orderId, orderId),
            eq(posOrderTenders.method, "points"),
            eq(posOrderTenders.status, "captured"),
          ),
        )
        .limit(1);
      if (pointsTender)
        throw new HttpError(
          409,
          "ORDER_HAS_POINTS_TENDER",
          "Member tidak bisa diganti karena pesanan ini sudah dibayar sebagian dengan poin.",
        );

      const setCustomer = async (
        profileId: string | null,
        via: OrderCustomerAttachVia | null,
      ) => {
        await tx
          .update(orders)
          .set({
            customerProfileId: profileId,
            customerAttachedBy: via === null ? null : actorUserId,
            customerAttachedVia: via,
            customerAttachedAt: via === null ? null : now,
            updatedAt: now,
          })
          .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)));
        await recordAudit(
          tx,
          context,
          {
            id: createUlid(now.getTime()),
            tenantId,
            outletId: order.outletId,
            actorType: "user",
            actorId: actorUserId,
            deviceId: null,
            action:
              via === null
                ? "order.customer_detached"
                : "order.customer_attached",
            objectType: "order",
            objectId: orderId,
            reason: null,
            maskedChanges: {
              before: null,
              after: { via: via ?? "none", attached: via !== null },
            },
            ipHash: null,
            sensitiveAccess: false,
            retentionClass: "audit_2y",
            createdAt: now.toISOString(),
          },
          AUDIT_SAFE_FIELDS,
        );
      };
      const summaryOf = (
        profile: { id: string; name: string } | null,
        via: OrderCustomerAttachVia | null,
      ): OrderCustomerSummary => ({
        orderId: order.id as OrderCustomerSummary["orderId"],
        customerProfileId: profile?.id ?? null,
        customerName: profile?.name ?? null,
        attachedVia: via,
        attachedAt: via === null ? null : now.toISOString(),
      });

      if (input.customerProfileId === null) {
        await setCustomer(null, null);
        return { kind: "ok", summary: summaryOf(null, null) };
      }

      let via: OrderCustomerAttachVia;
      let profile: typeof customerProfiles.$inferSelect | undefined;
      if (input.memberToken !== undefined) {
        via = "member_qr";
        const verified = verifyMemberQrToken(input.memberToken, tenantId, now);
        if (!verified)
          throw new HttpError(
            422,
            "MEMBER_TOKEN_INVALID",
            "QR member tidak valid atau sudah kedaluwarsa. Minta member memuat ulang QR.",
          );
        [profile] = await tx
          .select()
          .from(customerProfiles)
          .where(
            and(
              eq(customerProfiles.tenantId, tenantId),
              eq(customerProfiles.id, verified.customerProfileId),
            ),
          )
          .limit(1);
      } else {
        via = "phone_lookup";
        if (digest === null) throw new Error("Phone lookup without a digest");
        const [program] = await tx
          .select({ cap: loyaltyPrograms.phoneLookupDailyCapPerCashier })
          .from(loyaltyPrograms)
          .where(eq(loyaltyPrograms.tenantId, tenantId))
          .limit(1);
        const cap = program?.cap ?? DEFAULT_PHONE_LOOKUP_DAILY_CAP;
        // Serialise this cashier's lookups of the day so two concurrent
        // requests cannot both read `used < cap`.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`phone-lookup:${tenantId}:${actorUserId}:${order.businessDate}`}, 0))`,
        );
        const used = await countPhoneLookups(
          tx,
          tenantId,
          actorUserId,
          order.businessDate,
        );
        const anomaly = {
          tenantId,
          outletId: order.outletId,
          orderId,
          actorUserId,
          businessDate: order.businessDate,
        };
        if (used >= cap) {
          await recordLoyaltyAnomaly(tx, {
            ...anomaly,
            kind: "phone_lookup_cap_hit",
            details: { cap, used },
          });
          return {
            kind: "refused",
            error: crmHttpError("PHONE_LOOKUP_CAP_REACHED"),
          };
        }
        [profile] = await tx
          .select()
          .from(customerProfiles)
          .where(
            and(
              eq(customerProfiles.tenantId, tenantId),
              eq(customerProfiles.whatsappHash, digest),
              ne(customerProfiles.membershipStatus, "closed"),
            ),
          )
          .limit(1);
        await recordLoyaltyAnomaly(tx, {
          ...anomaly,
          kind: "phone_lookup_attach",
          customerProfileId: profile?.id ?? null,
          details: {
            matched: profile !== undefined,
            active: profile?.membershipStatus === "active",
          },
        });
      }

      if (!profile || profile.membershipStatus === "closed")
        return { kind: "refused", error: crmHttpError("CUSTOMER_NOT_FOUND") };
      // legend-9ehr6: a typed number must not reveal that it is registered but
      // not active; answer exactly like an unknown number. The member's own QR
      // (proof of presence) keeps the specific reason.
      if (profile.membershipStatus !== "active" && via === "phone_lookup")
        return { kind: "refused", error: crmHttpError("CUSTOMER_NOT_FOUND") };
      if (profile.membershipStatus !== "active")
        return {
          kind: "refused",
          error: crmHttpError("MEMBERSHIP_NOT_ACTIVE"),
        };

      await setCustomer(profile.id, via);
      return { kind: "ok", summary: summaryOf(profile, via) };
    },
  ).catch((error: unknown) => {
    // A payment completed between our read and write: the order trigger
    // (SQLSTATE 55000, constraint orders_customer_lock) refuses the change.
    if (isLockViolation(error, "orders_customer_lock"))
      throw new HttpError(
        409,
        "ORDER_NOT_UNPAID",
        "Pelanggan hanya bisa diubah sebelum pesanan dibayar.",
      );
    throw error;
  });
  if (outcome.kind === "refused") throw outcome.error;
  return outcome.summary;
}
