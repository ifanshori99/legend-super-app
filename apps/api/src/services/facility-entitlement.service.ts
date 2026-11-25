// Facility entitlement service (PRD v1.7 §3 F25 "Produk & Hak Akses", §6 K
// `entitlement_ledger`; bead legend-fjk5; FAC-04, FAC-05).
//
// Every movement of access rights is one append-only ledger row (see
// db/schema/facility-entitlement.ts); this service is the only writer.
// - `issueEntitlement`: the single door for a grant. It runs the contract
//   check `entitlementIssueCheck` (FAC-04: paid + condition met) and is
//   idempotent per (customer, source, source ref, rule).
// - `redeemEntitlement` (FAC-05): one transaction, serialised per (tenant,
//   customer, facility) with an advisory lock, draws one session from the
//   earliest-expiring grant that still has one. The DB trigger on non-grant
//   rows is the second guard (per-grant lock + overdraw check).
// - `cancelEntitlementsForSource`: a refunded source cancels what is left of
//   its grants (FAC-04); sessions already redeemed stay redeemed.
// - `expireDueEntitlements`: sweep that writes the `expire` row of lapsed
//   grants. Not scheduled by this card.
// - `getCurrentEntitlements`: balance + redeemable grants (customer.ts).
// Lock order is always customer key first, then the per-grant lock the
// trigger takes, so two writers cannot deadlock on each other.
import { createHash } from "node:crypto";
import {
  and,
  asc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  entitlementBalance,
  entitlementExpiresAt,
  entitlementIssueCheck,
  FacilityError,
  type EntitlementBalance,
  type EntitlementLedgerEntry,
  type EntitlementSource,
} from "@starter/shared/facility";
import { accessTickets, entitlementRules } from "../db/schema/facility.ts";
import { entitlementLedger } from "../db/schema/facility-entitlement.ts";
import { zonedInstant } from "./facility-rules.ts";
import { loadFacility, notFound, outletTimeZone } from "./facility-shared.ts";
import type { Tx } from "./inventory-ops.shared.ts";
import { assertFacilityTicketsEnabled } from "./facility-tickets-gate.ts";

export type LedgerRow = typeof entitlementLedger.$inferSelect;

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export type IssueEntitlementInput = {
  facilityId: string;
  customerProfileId: string;
  source: EntitlementSource;
  sourceRef: string;
  ruleId?: string | null;
  sessions: number;
  expiresAt: Date | null;
  paid: boolean;
  conditionsMet: boolean;
  actorUserId?: string | null;
  reason?: string | null;
  occurredAt?: Date;
};

export type IssueEntitlementResult =
  | { status: "issued" | "duplicate"; entry: LedgerRow }
  | { status: "rejected"; reason: "unpaid" | "conditions_not_met" };

// ---- Internals --------------------------------------------------------------

/** Serialises every writer of one customer's rights at one facility. */
export async function lockCustomer(
  tx: Tx,
  context: ScopedTenantContext,
  customerProfileId: string,
  facilityId: string,
): Promise<void> {
  const key = `entitlement:${context.tenant.tenantId}:${customerProfileId}:${facilityId}`;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

const grantAlias = alias(entitlementLedger, "g");

/** Sessions of a grant nobody drew down yet (redeem + cancel + expire rows). */
// Columns are written qualified (`g.`): drizzle drops the alias prefix in a
// one-table select, which would bind `tenant_id`/`id` to the subquery's `d`.
const remainingSql = sql<number>`(g.sessions - COALESCE((SELECT SUM(d.sessions) FROM entitlement_ledger d WHERE d.tenant_id = g.tenant_id AND d.grant_entry_id = g.id), 0))::int`;

type GrantWithRemaining = { grant: LedgerRow; remaining: number };

function splitRemaining(
  row: LedgerRow & { remaining: number },
): GrantWithRemaining {
  const { remaining, ...grant } = row;
  return { grant, remaining: Number(remaining) };
}

const grantColumns = {
  ...getTableColumns(grantAlias),
  remaining: remainingSql,
};

function assertSessions(sessions: number): void {
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > 100)
    throw new RangeError("Entitlement sessions must be an integer 1..100");
}

/** Writes the `cancel` / `expire` row that closes what is left of a grant. */
async function closeGrant(
  tx: Tx,
  grant: LedgerRow,
  remaining: number,
  type: "cancel" | "expire",
  input: { reason: string | null; occurredAt: Date },
): Promise<LedgerRow> {
  const [row] = await tx
    .insert(entitlementLedger)
    .values({
      tenantId: grant.tenantId,
      outletId: grant.outletId,
      facilityId: grant.facilityId,
      customerProfileId: grant.customerProfileId,
      type,
      sessions: remaining,
      sourceType: grant.sourceType,
      sourceRef: grant.sourceRef,
      ruleId: grant.ruleId,
      grantEntryId: grant.id,
      occurredAt: input.occurredAt,
      reason: input.reason?.slice(0, 500) ?? null,
    })
    .returning();
  if (!row) throw new Error("Entitlement close row was not written");
  return row;
}

async function loadGrantWithRemaining(
  tx: Tx,
  context: ScopedTenantContext,
  grantId: string,
): Promise<GrantWithRemaining | null> {
  const [row] = await tx
    .select(grantColumns)
    .from(grantAlias)
    .where(
      and(
        eq(grantAlias.tenantId, context.tenant.tenantId),
        eq(grantAlias.id, grantId),
        eq(grantAlias.type, "grant"),
      ),
    )
    .limit(1);
  return row ? splitRemaining(row) : null;
}

// ---- Issue ------------------------------------------------------------------

/**
 * FAC-04: issues one grant if the source is paid (where it must be) and its
 * condition is met. A replay of the same (customer, source, ref, rule) returns
 * the stored grant as `duplicate` and writes nothing.
 */
export async function issueEntitlement(
  tx: Tx,
  context: ScopedTenantContext,
  input: IssueEntitlementInput,
): Promise<IssueEntitlementResult> {
  assertFacilityTicketsEnabled();
  const check = entitlementIssueCheck({
    source: input.source,
    paid: input.paid,
    conditionsMet: input.conditionsMet,
  });
  if (!check.issuable)
    return {
      status: "rejected",
      reason: check.reason === "unpaid" ? "unpaid" : "conditions_not_met",
    };
  assertSessions(input.sessions);
  if (input.sourceRef.length < 1 || input.sourceRef.length > 40)
    throw new RangeError("Entitlement sourceRef must be 1..40 characters");
  if (input.source === "staff_issue" && !input.reason?.trim())
    throw new RangeError("A staff issue needs a reason");

  // Unknown or foreign facility answers 404 (RLS hides other outlets).
  const facility = await loadFacility(tx, context, input.facilityId);
  const tenantId = context.tenant.tenantId;
  const [created] = await tx
    .insert(entitlementLedger)
    .values({
      tenantId,
      outletId: facility.outletId,
      facilityId: facility.id,
      customerProfileId: input.customerProfileId,
      type: "grant",
      sessions: input.sessions,
      sourceType: input.source,
      sourceRef: input.sourceRef,
      ruleId: input.ruleId ?? null,
      expiresAt: input.expiresAt,
      occurredAt: input.occurredAt ?? new Date(),
      actorUserId: input.actorUserId ?? null,
      reason: input.reason?.trim().slice(0, 500) || null,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return { status: "issued", entry: created };

  const [existing] = await tx
    .select()
    .from(entitlementLedger)
    .where(
      and(
        eq(entitlementLedger.tenantId, tenantId),
        eq(entitlementLedger.facilityId, facility.id),
        eq(entitlementLedger.customerProfileId, input.customerProfileId),
        eq(entitlementLedger.type, "grant"),
        eq(entitlementLedger.sourceType, input.source),
        eq(entitlementLedger.sourceRef, input.sourceRef),
        sql`COALESCE(${entitlementLedger.ruleId}, ${NIL_UUID}::uuid) = ${input.ruleId ?? NIL_UUID}::uuid`,
      ),
    )
    .limit(1);
  if (!existing)
    throw new Error("Entitlement grant conflict without a stored grant");
  return { status: "duplicate", entry: existing };
}

/**
 * Tier benefit of one billing month (called by the monthly scheduler card).
 * Idempotency: `sourceRef` is a deterministic UUID of "<ruleId>:<YYYY-MM>"
 * (the ledger sourceRef holds a UUID or ULID, max 40 chars) and the rule id is
 * part of the grant key, so the same rule issues once per customer per month.
 * The period is also written into `reason`.
 */
export async function issueTierBenefit(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    facilityId: string;
    customerProfileId: string;
    ruleId: string;
    /** Billing month, outlet calendar: "YYYY-MM". */
    period: string;
    /** The customer's current loyalty tier key (WS-08). */
    tierKey: string;
    actorUserId?: string | null;
    occurredAt?: Date;
  },
): Promise<IssueEntitlementResult> {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(input.period);
  if (!match) throw new RangeError("Tier benefit period must be YYYY-MM");
  const facility = await loadFacility(tx, context, input.facilityId);
  const [rule] = await tx
    .select()
    .from(entitlementRules)
    .where(
      and(
        eq(entitlementRules.tenantId, context.tenant.tenantId),
        eq(entitlementRules.id, input.ruleId),
        eq(entitlementRules.facilityId, facility.id),
        eq(entitlementRules.type, "tier_benefit"),
      ),
    )
    .limit(1);
  if (!rule) throw notFound("Aturan hak akses");
  const tierKeys = (rule.condition as { tierKeys?: string[] }).tierKeys ?? [];
  const occurredAt = input.occurredAt ?? new Date();
  const timeZone = await outletTimeZone(tx, context, facility.outletId);
  const nextMonth = new Date(Date.UTC(Number(match[1]), Number(match[2]), 1));
  const periodEnd = zonedInstant(
    nextMonth.toISOString().slice(0, 10),
    0,
    timeZone,
  );
  const expiresAt = expiryOfValidity(rule.validity, {
    occurredAt,
    operatingDayEndsAt: operatingDayEnd(
      facility.operatingHours,
      localDate(occurredAt, timeZone),
      timeZone,
    ),
    billingPeriodEndsAt: periodEnd,
  });
  const digest = createHash("sha256")
    .update(`tier_benefit:${rule.id}:${input.period}`)
    .digest("hex");
  // UUID v5 shape: version nibble 5, variant nibble 8..b.
  const variant = ((parseInt(digest.charAt(16), 16) & 0x3) | 0x8).toString(16);
  const sourceRef = [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
  return issueEntitlement(tx, context, {
    facilityId: facility.id,
    customerProfileId: input.customerProfileId,
    source: "tier_benefit",
    sourceRef,
    ruleId: rule.id,
    sessions: rule.sessions,
    expiresAt,
    paid: false,
    conditionsMet: rule.isEnabled && tierKeys.includes(input.tierKey),
    actorUserId: input.actorUserId ?? null,
    reason: `Tier benefit ${input.period}`,
    occurredAt,
  });
}

// ---- Expiry arithmetic (shared with the consumer) ---------------------------

type RuleValidity = (typeof entitlementRules.$inferSelect)["validity"];

/** Outlet-local calendar date ("YYYY-MM-DD") of an instant. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/**
 * Closing instant of the facility on a business date: the latest `closesAt`
 * of the hours that apply to that weekday (a closing at or before the opening
 * means after midnight). No hours that day: the end of the business date.
 */
export function operatingDayEnd(
  hours: ReadonlyArray<{
    daysOfWeek: readonly number[];
    opensAt: string;
    closesAt: string;
  }>,
  businessDate: string,
  timeZone: string,
): Date {
  const [year, month, day] = businessDate.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  let closing = 0;
  for (const entry of hours) {
    if (!entry.daysOfWeek.includes(weekday)) continue;
    const [oh, om] = entry.opensAt.split(":").map(Number);
    const [ch, cm] = entry.closesAt.split(":").map(Number);
    const opens = oh * 60 + om;
    let closes = ch * 60 + cm;
    if (closes <= opens) closes += 1440;
    closing = Math.max(closing, closes);
  }
  return zonedInstant(businessDate, closing === 0 ? 1440 : closing, timeZone);
}

/**
 * Q78: the closing instant an `operating_day` grant bought at `notBefore`
 * lives until. Normally the closing of the business date; when the sale came
 * after that closing, the closing of the next day the facility has hours (a
 * paid package is never born expired). No hours at all: the old behaviour,
 * the end of the business date.
 */
export function operatingDayEndAfter(
  hours: ReadonlyArray<{
    daysOfWeek: readonly number[];
    opensAt: string;
    closesAt: string;
  }>,
  businessDate: string,
  timeZone: string,
  notBefore: Date,
): Date {
  // A stale business date (an open bill paid days later) starts the search at
  // the day before the sale, so the last day an overnight closing could still
  // cover the sale is not skipped.
  const sale = localDate(notBefore, timeZone);
  const [sy, sm, sd] = sale.split("-").map(Number);
  const dayBeforeSale = new Date(Date.UTC(sy, sm - 1, sd - 1))
    .toISOString()
    .slice(0, 10);
  const start = dayBeforeSale > businessDate ? dayBeforeSale : businessDate;
  const [year, month, day] = start.split("-").map(Number);
  for (let offset = 0; offset < 8 && hours.length > 0; offset += 1) {
    const date = new Date(Date.UTC(year, month - 1, day + offset));
    if (!hours.some((entry) => entry.daysOfWeek.includes(date.getUTCDay())))
      continue;
    const end = operatingDayEnd(
      hours,
      date.toISOString().slice(0, 10),
      timeZone,
    );
    if (end.getTime() > notBefore.getTime()) return end;
  }
  // No usable hours: the end of the business date, but never before the sale
  // (a cutoff past midnight puts the sale after that date's midnight).
  const fallback = operatingDayEnd(hours, businessDate, timeZone);
  return fallback.getTime() > notBefore.getTime()
    ? fallback
    : operatingDayEnd([], sale, timeZone);
}

/** Expiry of a grant from the rule validity (contract `entitlementExpiresAt`). */
export function expiryOfValidity(
  validity: RuleValidity,
  input: {
    occurredAt: Date;
    operatingDayEndsAt: Date;
    billingPeriodEndsAt?: Date;
  },
): Date | null {
  if (validity.kind === "billing_period" && input.billingPeriodEndsAt)
    return input.billingPeriodEndsAt;
  const iso = entitlementExpiresAt(validity, {
    issuedAt: input.occurredAt.toISOString(),
    operatingDayEndsAt: input.operatingDayEndsAt.toISOString(),
  });
  return iso === null ? null : new Date(iso);
}

// ---- Redeem -----------------------------------------------------------------

/**
 * FAC-05: draws one session for `accessTicketId`. Throws
 * ENTITLEMENT_INSUFFICIENT when no unexpired grant has a session left and
 * ENTITLEMENT_ALREADY_REDEEMED when the ticket already consumed one. With
 * `linkTicket` the ticket's `entitlement_ledger_id` is set to the redeem row.
 */
export async function redeemEntitlement(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    facilityId: string;
    customerProfileId: string;
    accessTicketId: string;
    at?: Date;
    linkTicket?: boolean;
  },
): Promise<{ entry: LedgerRow; grantEntryId: string }> {
  assertFacilityTicketsEnabled();
  const tenantId = context.tenant.tenantId;
  const at = input.at ?? new Date();
  const facility = await loadFacility(tx, context, input.facilityId);
  await lockCustomer(tx, context, input.customerProfileId, facility.id);

  const [claimed] = await tx
    .select({ id: entitlementLedger.id })
    .from(entitlementLedger)
    .where(
      and(
        eq(entitlementLedger.tenantId, tenantId),
        eq(entitlementLedger.accessTicketId, input.accessTicketId),
      ),
    )
    .limit(1);
  if (claimed) throw new FacilityError("ENTITLEMENT_ALREADY_REDEEMED");

  if (input.linkTicket) {
    const [ticket] = await tx
      .select({ entitlementLedgerId: accessTickets.entitlementLedgerId })
      .from(accessTickets)
      .where(
        and(
          eq(accessTickets.tenantId, tenantId),
          eq(accessTickets.id, input.accessTicketId),
          eq(accessTickets.facilityId, facility.id),
          eq(accessTickets.customerProfileId, input.customerProfileId),
        ),
      )
      .limit(1);
    if (!ticket) throw notFound("Tiket");
    if (ticket.entitlementLedgerId !== null)
      throw new FacilityError("ENTITLEMENT_ALREADY_REDEEMED");
  }

  const [candidate] = await tx
    .select(grantColumns)
    .from(grantAlias)
    .where(
      and(
        eq(grantAlias.tenantId, tenantId),
        eq(grantAlias.facilityId, facility.id),
        eq(grantAlias.customerProfileId, input.customerProfileId),
        eq(grantAlias.type, "grant"),
        or(isNull(grantAlias.expiresAt), gt(grantAlias.expiresAt, at)),
        sql`${remainingSql} > 0`,
      ),
    )
    .orderBy(
      sql`${grantAlias.expiresAt} ASC NULLS LAST`,
      asc(grantAlias.postingSeq),
    )
    .limit(1);
  if (!candidate) throw new FacilityError("ENTITLEMENT_INSUFFICIENT");
  const { grant } = splitRemaining(candidate);

  const [entry] = await tx
    .insert(entitlementLedger)
    .values({
      tenantId,
      outletId: grant.outletId,
      facilityId: grant.facilityId,
      customerProfileId: grant.customerProfileId,
      type: "redeem",
      sessions: 1,
      sourceType: grant.sourceType,
      sourceRef: grant.sourceRef,
      ruleId: grant.ruleId,
      grantEntryId: grant.id,
      accessTicketId: input.accessTicketId,
      occurredAt: at,
    })
    .onConflictDoNothing()
    .returning();
  // The only unique key a redeem row can hit is its ticket (FAC-05).
  if (!entry) throw new FacilityError("ENTITLEMENT_ALREADY_REDEEMED");

  if (input.linkTicket)
    await tx
      .update(accessTickets)
      .set({ entitlementLedgerId: entry.id })
      .where(
        and(
          eq(accessTickets.tenantId, tenantId),
          eq(accessTickets.id, input.accessTicketId),
        ),
      );
  return { entry, grantEntryId: grant.id };
}

// ---- Cancel (refund) --------------------------------------------------------

/**
 * FAC-04: the source transaction was refunded. Writes one `cancel` row per
 * grant of that source for what is still unredeemed; a grant with nothing left
 * writes nothing, so a replay is a no-op.
 */
export async function cancelEntitlementsForSource(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    sourceRef: string;
    sourceTypes?: EntitlementSource[];
    /** Only the grants of these rules (a refund can hit one rule's grant). */
    ruleIds?: string[];
    reason?: string | null;
    occurredAt?: Date;
  },
): Promise<{ cancelledSessions: number; entries: LedgerRow[] }> {
  const tenantId = context.tenant.tenantId;
  const grants = await tx
    .select({
      id: entitlementLedger.id,
      customerProfileId: entitlementLedger.customerProfileId,
      facilityId: entitlementLedger.facilityId,
    })
    .from(entitlementLedger)
    .where(
      and(
        eq(entitlementLedger.tenantId, tenantId),
        eq(entitlementLedger.type, "grant"),
        eq(entitlementLedger.sourceRef, input.sourceRef),
        ...(input.sourceTypes?.length
          ? [inArray(entitlementLedger.sourceType, input.sourceTypes)]
          : []),
        ...(input.ruleIds
          ? [inArray(entitlementLedger.ruleId, input.ruleIds)]
          : []),
      ),
    )
    .orderBy(
      asc(entitlementLedger.customerProfileId),
      asc(entitlementLedger.facilityId),
      asc(entitlementLedger.id),
    );
  const entries: LedgerRow[] = [];
  let cancelledSessions = 0;
  for (const target of grants) {
    // Lock first, then read what is left: a racing redeem is already in.
    await lockCustomer(
      tx,
      context,
      target.customerProfileId,
      target.facilityId,
    );
    const current = await loadGrantWithRemaining(tx, context, target.id);
    if (!current || current.remaining <= 0) continue;
    entries.push(
      await closeGrant(tx, current.grant, current.remaining, "cancel", {
        reason: input.reason ?? null,
        occurredAt: input.occurredAt ?? new Date(),
      }),
    );
    cancelledSessions += current.remaining;
  }
  return { cancelledSessions, entries };
}

// ---- Expire (sweep) ---------------------------------------------------------

/** Writes the `expire` row of every grant past `expires_at` that has sessions left. */
export async function expireDueEntitlements(
  tx: Tx,
  context: ScopedTenantContext,
  now: Date,
): Promise<{ expiredSessions: number; entries: LedgerRow[] }> {
  const due = await tx
    .select({
      id: grantAlias.id,
      customerProfileId: grantAlias.customerProfileId,
      facilityId: grantAlias.facilityId,
    })
    .from(grantAlias)
    .where(
      and(
        eq(grantAlias.tenantId, context.tenant.tenantId),
        eq(grantAlias.type, "grant"),
        sql`${grantAlias.expiresAt} <= ${now}`,
        sql`${remainingSql} > 0`,
      ),
    )
    .orderBy(
      asc(grantAlias.customerProfileId),
      asc(grantAlias.facilityId),
      asc(grantAlias.id),
    );
  const entries: LedgerRow[] = [];
  let expiredSessions = 0;
  for (const target of due) {
    await lockCustomer(
      tx,
      context,
      target.customerProfileId,
      target.facilityId,
    );
    const current = await loadGrantWithRemaining(tx, context, target.id);
    if (!current || current.remaining <= 0) continue;
    entries.push(
      await closeGrant(tx, current.grant, current.remaining, "expire", {
        reason: null,
        occurredAt: now,
      }),
    );
    expiredSessions += current.remaining;
  }
  return { expiredSessions, entries };
}

// ---- Read -------------------------------------------------------------------

function toEntry(row: LedgerRow): EntitlementLedgerEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    facilityId: row.facilityId,
    customerProfileId: row.customerProfileId,
    type: row.type,
    sessions: row.sessions,
    sourceType: row.sourceType,
    sourceRef: row.sourceRef,
    accessTicketId: row.accessTicketId,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    occurredAt: row.occurredAt.toISOString(),
    actorUserId: row.actorUserId,
    reason: row.reason,
  } as EntitlementLedgerEntry;
}

/**
 * Balance and the grants the customer can still draw from, soonest expiry
 * first (shape of `getCurrentEntitlements` in customer.ts). A grant past its
 * expiry whose `expire` row the sweep has not written yet counts as expired
 * here (a synthetic row), so the balance never shows unusable sessions.
 * `sessions` of a grant is what is left of it.
 */
export async function getCurrentEntitlements(
  tx: Tx,
  context: ScopedTenantContext,
  input: { customerProfileId: string; facilityId: string; at?: Date },
): Promise<{
  balance: EntitlementBalance;
  grants: Array<{
    id: string;
    source: EntitlementSource;
    sessions: number;
    expiresAt: string | null;
    grantedAt: string;
  }>;
}> {
  const at = input.at ?? new Date();
  const facility = await loadFacility(tx, context, input.facilityId);
  const rows = await tx
    .select()
    .from(entitlementLedger)
    .where(
      and(
        eq(entitlementLedger.tenantId, context.tenant.tenantId),
        eq(entitlementLedger.facilityId, facility.id),
        eq(entitlementLedger.customerProfileId, input.customerProfileId),
      ),
    )
    .orderBy(asc(entitlementLedger.postingSeq));

  const used = new Map<string, number>();
  for (const row of rows)
    if (row.type !== "grant" && row.grantEntryId)
      used.set(
        row.grantEntryId,
        (used.get(row.grantEntryId) ?? 0) + row.sessions,
      );

  const entries = rows.map(toEntry);
  const redeemable: Array<{ row: LedgerRow; remaining: number }> = [];
  for (const row of rows) {
    if (row.type !== "grant") continue;
    const remaining = row.sessions - (used.get(row.id) ?? 0);
    if (remaining <= 0) continue;
    if (row.expiresAt !== null && row.expiresAt.getTime() <= at.getTime()) {
      entries.push({
        ...toEntry(row),
        type: "expire",
        sessions: remaining,
        expiresAt: null,
        occurredAt: row.expiresAt.toISOString(),
      });
      continue;
    }
    redeemable.push({ row, remaining });
  }
  redeemable.sort((a, b) => {
    const left = a.row.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const right = b.row.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
    return left - right || a.row.postingSeq - b.row.postingSeq;
  });
  return {
    balance: entitlementBalance(entries, {
      customerProfileId: input.customerProfileId,
      facilityId: facility.id,
      at,
    }),
    grants: redeemable.map(({ row, remaining }) => ({
      id: row.id,
      source: row.sourceType,
      sessions: remaining,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      grantedAt: row.occurredAt.toISOString(),
    })),
  };
}
