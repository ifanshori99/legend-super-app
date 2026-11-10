// Customer 360 for staff (legend-ts50, docs/briefs/290d): the customer list
// and the one-customer detail. Every function runs in `withTenant`, so RLS
// scopes rows to the tenant; a customer of another tenant is indistinguishable
// from an unknown id (404 CUSTOMER_NOT_FOUND).
//
// Personal data: the WhatsApp number is sealed in `user_identities`. It is
// returned masked unless the caller holds `crm.customer.pii.read` (the route
// decides and passes `revealPii`); each full reveal writes an audit row that
// names the actor and the profile, never the number. The list never carries a
// number, and a phone-number search is answered with an empty page for staff
// without the permission, whether or not the number is registered (same
// no-oracle rule as the cashier phone lookup, pos-order-customer.service.ts).

import {
  and,
  desc,
  eq,
  gt,
  gte,
  ilike,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import {
  createUlid,
  decodeCursor,
  encodeCursor,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  customer360Schema,
  customerConsentSchema,
  customerProfileDtoSchema,
  feedbackSchema,
  tierProgressBp,
  type Customer360,
  type CustomerProfileDto,
} from "@starter/shared/crm";
import type { Idr } from "@starter/shared/core";
import { db } from "../db";
import { consents, userIdentities } from "../db/schema";
import { customerProfiles, loyaltyPrograms } from "../db/schema/crm-member";
import { customerVisits } from "../db/schema/crm-ledger";
import { vouchers } from "../db/schema/crm-promo";
import { feedback } from "../db/schema/crm-feedback";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { whatsAppDigest } from "../lib/identity-digest";
import { openSecret } from "../lib/secrets";
import { recordAudit } from "./core-audit";
import { crmHttpError, toVoucher } from "./crm-promo-engine";
import { memberFavorites } from "./member-favorites.service";
import { toCustomerProfileDto } from "./member-profile.service";

type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

export type ListCustomersQuery = {
  cursor?: string;
  limit: number;
  q?: string;
  tierId?: string;
  membershipStatus?: CustomerProfileDto["membershipStatus"];
};

/** The WhatsApp number of a Customer 360: full only for `crm.customer.pii.read`. */
export type CustomerWhatsapp = {
  number: string | null;
  masked: boolean;
};

export type Customer360View = Customer360 & { whatsapp: CustomerWhatsapp };

const RECENT_VISITS = 10;
const RECENT_FEEDBACK = 5;
const ACTIVE_VOUCHERS = 20;
const DEFAULT_ROLLING_MONTHS = 12;
const AUDIT_SAFE_FIELDS = ["revealed"] as const;

// A search that is a phone number (digits, +, spaces, dashes, brackets).
const PHONE_SEARCH = /^\+?[\d\s\-()]+$/;
const MIN_PHONE_DIGITS = 6;

export function isPhoneSearch(q: string): boolean {
  return (
    PHONE_SEARCH.test(q) && q.replace(/\D/g, "").length >= MIN_PHONE_DIGITS
  );
}

function toDto(row: typeof customerProfiles.$inferSelect): CustomerProfileDto {
  const { whatsappHash, ...dto } = toCustomerProfileDto(row);
  void whatsappHash; // never leaves the server
  return customerProfileDtoSchema.parse(dto);
}

function cursorKeys(cursor: string): [string, string] {
  let keys;
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw new HttpError(422, "VALIDATION_ERROR", "Kursor tidak valid.");
  }
  const [at, id] = keys;
  if (typeof at !== "string" || typeof id !== "string")
    throw new HttpError(422, "VALIDATION_ERROR", "Kursor tidak valid.");
  return [at, id];
}

function emptyPage(limit: number): Page<CustomerProfileDto> {
  return { data: [], meta: { limit, nextCursor: null } };
}

/**
 * Customers of the tenant, newest first. `q` searches the name; a phone
 * number is matched on its digest only for staff with `revealPii`, and answers
 * an empty page for everyone else (no registered/unknown oracle).
 */
export async function listCustomers(
  context: ScopedTenantContext,
  query: ListCustomersQuery,
  revealPii: boolean,
): Promise<Page<CustomerProfileDto>> {
  const tenantId = context.tenant.tenantId;
  // No tier table yet (profiles carry tierId null until 290e): a tier filter
  // can match nothing.
  if (query.tierId !== undefined) return emptyPage(query.limit);

  const filters = [eq(customerProfiles.tenantId, tenantId)];
  if (query.membershipStatus)
    filters.push(eq(customerProfiles.membershipStatus, query.membershipStatus));
  if (query.q !== undefined) {
    if (isPhoneSearch(query.q)) {
      if (!revealPii) return emptyPage(query.limit);
      let digest: string;
      try {
        digest = await whatsAppDigest(query.q);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        return emptyPage(query.limit);
      }
      filters.push(eq(customerProfiles.whatsappHash, digest));
    } else {
      const escaped = query.q.replace(/[\\%_]/g, "\\$&");
      filters.push(ilike(customerProfiles.name, `%${escaped}%`));
    }
  }
  if (query.cursor) {
    const [at, id] = cursorKeys(query.cursor);
    const atDate = new Date(at);
    if (Number.isNaN(atDate.getTime()))
      throw new HttpError(422, "VALIDATION_ERROR", "Kursor tidak valid.");
    filters.push(
      or(
        lt(customerProfiles.createdAt, atDate),
        and(
          eq(customerProfiles.createdAt, atDate),
          lt(customerProfiles.id, id),
        ),
      )!,
    );
  }

  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(customerProfiles)
      .where(and(...filters))
      .orderBy(desc(customerProfiles.createdAt), desc(customerProfiles.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toDto),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.createdAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

/**
 * The sealed number of the profile's account. Stored by the identity module
 * under `user_identity:whatsapp:<digest>`. Null when there is no identity or
 * the envelope does not open.
 */
async function openWhatsappNumber(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string | null,
): Promise<string | null> {
  if (userId === null) return null;
  const [identity] = await tx
    .select({
      valueHash: userIdentities.valueHash,
      valueEncrypted: userIdentities.valueEncrypted,
    })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.userId, userId),
        eq(userIdentities.type, "whatsapp"),
      ),
    )
    .orderBy(
      desc(userIdentities.isPrimary),
      sql`${userIdentities.verifiedAt} DESC NULLS LAST`,
    )
    .limit(1);
  if (!identity?.valueEncrypted) return null;
  try {
    return openSecret(
      identity.valueEncrypted,
      `user_identity:whatsapp:${identity.valueHash}`,
    );
  } catch {
    return null;
  }
}

/** `+62••••••7890`: country code and the last four digits only. */
export function maskWhatsappNumber(number: string): string {
  const digits = number.replace(/\D/g, "");
  if (digits.length <= 6) return "•".repeat(digits.length);
  return `+${digits.slice(0, 2)}${"•".repeat(digits.length - 6)}${digits.slice(-4)}`;
}

function fullWhatsappNumber(number: string): string {
  return `+${number.replace(/\D/g, "")}`;
}

/** Consent history as grant periods: a withdrawal closes the open grant. */
function consentPeriods(rows: (typeof consents.$inferSelect)[]) {
  const periods: {
    id: string;
    tenantId: string;
    customerProfileId: string;
    purpose: string;
    policyVersion: string;
    grantedAt: string;
    withdrawnAt: string | null;
    source: string;
  }[] = [];
  for (const row of rows) {
    if (row.decision === "granted") {
      periods.push({
        id: row.id,
        tenantId: row.tenantId,
        customerProfileId: row.subjectId,
        purpose: row.purpose,
        policyVersion: row.policyVersion,
        grantedAt: row.recordedAt.toISOString(),
        withdrawnAt: null,
        source: row.source,
      });
    } else {
      const open = periods.findLast(
        (period) =>
          period.purpose === row.purpose && period.withdrawnAt === null,
      );
      if (open) open.withdrawnAt = row.recordedAt.toISOString();
    }
  }
  return periods.map((period) => customerConsentSchema.parse(period));
}

/**
 * One customer with tier progress, recent visits, favorites, recent feedback
 * and open vouchers. `revealPii` (the caller holds `crm.customer.pii.read`)
 * returns the full number and writes an audit row; otherwise the number is
 * masked. Throws 404 CUSTOMER_NOT_FOUND for an unknown or foreign id.
 */
export async function getCustomer360(
  context: ScopedTenantContext,
  actorUserId: string,
  customerProfileId: string,
  revealPii: boolean,
  now = new Date(),
): Promise<Customer360View> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [profile] = await tx
      .select()
      .from(customerProfiles)
      .where(
        and(
          eq(customerProfiles.tenantId, tenantId),
          eq(customerProfiles.id, customerProfileId),
        ),
      )
      .limit(1);
    if (!profile) throw crmHttpError("CUSTOMER_NOT_FOUND");

    const [program] = await tx
      .select({ rollingMonths: loyaltyPrograms.rollingMonths })
      .from(loyaltyPrograms)
      .where(eq(loyaltyPrograms.tenantId, tenantId))
      .limit(1);
    const windowStart = new Date(now);
    windowStart.setUTCMonth(
      windowStart.getUTCMonth() -
        (program?.rollingMonths ?? DEFAULT_ROLLING_MONTHS),
    );
    const [rolling] = await tx
      .select({
        spend: sql<string>`coalesce(sum(${customerVisits.spendIdr}), 0)`,
        visits: sql<number>`count(*)::int`,
      })
      .from(customerVisits)
      .where(
        and(
          eq(customerVisits.tenantId, tenantId),
          eq(customerVisits.customerProfileId, profile.id),
          gte(customerVisits.visitedAt, windowStart),
        ),
      );
    const rollingSpendIdr = Number(rolling?.spend ?? 0) as Idr;
    const rollingVisits = rolling?.visits ?? 0;

    const consentRows = await tx
      .select()
      .from(consents)
      .where(
        and(
          eq(consents.tenantId, tenantId),
          eq(consents.subjectId, profile.id),
        ),
      )
      .orderBy(consents.seq);
    const visitRows = await tx
      .select()
      .from(customerVisits)
      .where(
        and(
          eq(customerVisits.tenantId, tenantId),
          eq(customerVisits.customerProfileId, profile.id),
        ),
      )
      .orderBy(desc(customerVisits.visitedAt), desc(customerVisits.id))
      .limit(RECENT_VISITS);
    const feedbackRows = await tx
      .select()
      .from(feedback)
      .where(
        and(
          eq(feedback.tenantId, tenantId),
          eq(feedback.customerProfileId, profile.id),
        ),
      )
      .orderBy(desc(feedback.createdAt), desc(feedback.id))
      .limit(RECENT_FEEDBACK);
    const voucherRows = await tx
      .select()
      .from(vouchers)
      .where(
        and(
          eq(vouchers.tenantId, tenantId),
          eq(vouchers.customerProfileId, profile.id),
          eq(vouchers.status, "issued"),
          or(isNull(vouchers.validUntil), gt(vouchers.validUntil, now)),
        ),
      )
      .orderBy(desc(vouchers.issuedAt), desc(vouchers.id))
      .limit(ACTIVE_VOUCHERS);
    const favoriteItems = await memberFavorites(tx, profile.id);

    const number = await openWhatsappNumber(tx, profile.userId);
    if (revealPii) {
      // Every opening is its own audit row; it names who and what, never the number.
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(now.getTime()),
          tenantId,
          outletId: null,
          actorType: "user",
          actorId: actorUserId,
          deviceId: null,
          action: "customer.pii_revealed",
          objectType: "customer_profile",
          objectId: profile.id,
          // Sensitive access requires a reason (audit contract).
          reason: "Staf membuka nomor WhatsApp pelanggan.",
          maskedChanges: { before: null, after: { revealed: number !== null } },
          ipHash: null,
          sensitiveAccess: true,
          retentionClass: "audit_2y",
          createdAt: now.toISOString(),
        },
        AUDIT_SAFE_FIELDS,
      );
    }

    const stats = { rollingSpendIdr, rollingVisits };
    const detail = customer360Schema.parse({
      profile: toDto(profile),
      consents: consentPeriods(consentRows),
      // No tier table yet (profiles carry tierId null until 290e).
      currentTier: null,
      nextTier: null,
      tierProgressBp: tierProgressBp(stats, null),
      rollingSpendIdr,
      rollingVisits,
      recentVisits: visitRows.map((row) => ({
        orderId: row.orderId,
        outletId: row.outletId,
        visitedAt: row.visitedAt.toISOString(),
        spendIdr: row.spendIdr,
        itemCount: row.itemCount,
      })),
      favoriteItems,
      recentFeedback: feedbackRows.map((row) =>
        feedbackSchema.parse({
          id: row.id,
          tenantId: row.tenantId,
          outletId: row.outletId,
          tableSessionId: row.tableSessionId,
          customerProfileId: row.customerProfileId,
          orderId: row.orderId,
          kind: row.kind,
          rating: row.rating,
          comment: row.comment,
          status: row.status,
          handledBy: row.handledBy,
          handledNote: row.handledNote,
          createdAt: row.createdAt.toISOString(),
          resolvedAt: row.resolvedAt?.toISOString() ?? null,
        }),
      ),
      activeVouchers: voucherRows.map((row) => {
        const { codeHash, ...rest } = toVoucher(row);
        void codeHash; // only the digest is stored; it never leaves the server
        return rest;
      }),
    });
    return {
      ...detail,
      whatsapp: {
        number:
          number === null
            ? null
            : revealPii
              ? fullWhatsappNumber(number)
              : maskWhatsappNumber(number),
        masked: !revealPii,
      },
    };
  });
}
