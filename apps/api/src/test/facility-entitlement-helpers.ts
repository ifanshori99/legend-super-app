// Shared fixtures for the legend-fjk5 facility entitlement tests
// (facility-entitlement, facility-entitlement-consumer). Not a test file.
//
// Seeding uses raw SQL as the migration owner (tenant GUCs set, RLS is forced);
// the services under test always run as legend_app through `withTenant`.
// Reuses the world/profile/order fixtures of the member tests.

import { randomUUID } from "node:crypto";
import {
  createUlid,
  outletIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EntitlementSource } from "@starter/shared/facility";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  cancelEntitlementsForSource,
  expireDueEntitlements,
  getCurrentEntitlements,
  issueEntitlement,
  redeemEntitlement,
} from "../services/facility-entitlement.service.ts";
import { deliverFacilityEntitlementEvent } from "../services/facility-entitlement-consumer.ts";
import type { EventEnvelope } from "@starter/shared/events";
import { NOW, asTenant, short, type World } from "./member-loyalty-helpers.ts";

export { NOW };

export const HOUR = 3_600_000;
/** Business date of NOW: 2026-11-08 10:00 in Jakarta (cutoff 04:00). */
export const TODAY = "2026-11-08";
export const PAID_AT = new Date(NOW.getTime() - HOUR).toISOString();
export const inHours = (hours: number, from: Date = NOW) =>
  new Date(from.getTime() + hours * HOUR);

export type Entitlements = {
  issue: (
    input: Partial<Parameters<typeof issueEntitlement>[2]> & {
      facilityId: string;
      customerProfileId: string;
    },
    context?: ScopedTenantContext,
  ) => ReturnType<typeof issueEntitlement>;
  redeem: (
    input: {
      facilityId: string;
      customerProfileId: string;
      accessTicketId?: string;
      at?: Date;
    },
    context?: ScopedTenantContext,
  ) => ReturnType<typeof redeemEntitlement>;
  cancel: (
    input: Parameters<typeof cancelEntitlementsForSource>[2],
    context?: ScopedTenantContext,
  ) => ReturnType<typeof cancelEntitlementsForSource>;
  expire: (
    now: Date,
    context?: ScopedTenantContext,
  ) => ReturnType<typeof expireDueEntitlements>;
  current: (
    input: { facilityId: string; customerProfileId: string; at?: Date },
    context?: ScopedTenantContext,
  ) => ReturnType<typeof getCurrentEntitlements>;
};

/** Service calls, each in its own transaction (a failed call aborts only itself). */
export function entitlementsOf(world: World): Entitlements {
  return {
    issue: (input, context = world.context) =>
      withTenant(db, context, (tx) =>
        issueEntitlement(tx, context, {
          source: "purchase" as EntitlementSource,
          sourceRef: `ref-${short()}`,
          ruleId: null,
          sessions: 1,
          expiresAt: inHours(24),
          paid: true,
          conditionsMet: true,
          occurredAt: NOW,
          // The brief makes a reason mandatory for staff issues.
          ...(input.source === "staff_issue"
            ? { reason: "Kompensasi uji" }
            : {}),
          ...input,
        }),
      ),
    redeem: (input, context = world.context) =>
      withTenant(db, context, (tx) =>
        redeemEntitlement(tx, context, {
          accessTicketId: createUlid(),
          at: NOW,
          ...input,
        }),
      ),
    cancel: (input, context = world.context) =>
      withTenant(db, context, (tx) =>
        cancelEntitlementsForSource(tx, context, input),
      ),
    expire: (now, context = world.context) =>
      withTenant(db, context, (tx) => expireDueEntitlements(tx, context, now)),
    current: (input, context = world.context) =>
      withTenant(db, context, (tx) =>
        getCurrentEntitlements(tx, context, { at: NOW, ...input }),
      ),
  };
}

/** Context limited to one outlet (RLS outlet scope). */
export function outletContext(
  tenantId: string,
  outletId: string,
): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );
}

/** One facility (a shower unless `type` says otherwise), open all day every day. */
export async function seedFacility(
  world: Pick<World, "tenantId" | "outletA">,
  outletId: string = world.outletA,
  type: "shower" | "locker" | "meeting_room" | "coworking" = "shower",
): Promise<string> {
  const facilityId = randomUUID();
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, $4, $8, 20, 10, 10, $5, $6, $7)`,
      [
        facilityId,
        world.tenantId,
        outletId,
        `${type} ${facilityId.slice(0, 8)}`,
        JSON.stringify([
          {
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            opensAt: "00:00",
            closesAt: "23:59",
          },
        ]),
        JSON.stringify({
          graceMinutes: 5,
          blockMinutes: 15,
          feePerBlockIdr: 5000,
        }),
        JSON.stringify({
          freeCancelMinutesBefore: 30,
          lateCancelResolution: "no_refund",
          lateCancelFeeIdr: 0,
          noShowResolution: "no_refund",
        }),
        type,
      ],
    ),
  );
  return facilityId;
}

export type RuleSeed = {
  facilityId: string;
  outletId: string;
  type: "package" | "min_spend";
  condition: { menuItemId: string } | { minSpendIdr: number };
  sessions?: number;
  validity?:
    | { kind: "operating_day" }
    | { kind: "duration_hours"; hours: number }
    | { kind: "billing_period" };
  isEnabled?: boolean;
};

export async function seedRule(
  world: Pick<World, "tenantId">,
  seed: RuleSeed,
): Promise<string> {
  const id = randomUUID();
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO entitlement_rules (id, tenant_id, outlet_id, facility_id, type, condition, sessions, validity, is_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        world.tenantId,
        seed.outletId,
        seed.facilityId,
        seed.type,
        JSON.stringify(seed.condition),
        seed.sessions ?? 1,
        JSON.stringify(seed.validity ?? { kind: "duration_hours", hours: 24 }),
        seed.isEnabled ?? true,
      ],
    ),
  );
  return id;
}

/** A single-ticket product of `facilityId` that sells through `menuItemId`. */
export async function seedTicketProduct(
  tenantId: string,
  seed: { facilityId: string; outletId: string; menuItemId: string },
): Promise<string> {
  const id = randomUUID();
  await asTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO facility_products
         (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions, is_active, menu_item_id)
       VALUES ($1, $2, $3, $4, 'Tiket Uji', 'single', 25000, 1, true, $5)`,
      [id, tenantId, seed.outletId, seed.facilityId, seed.menuItemId],
    ),
  );
  return id;
}

/** Menu items of the world's brand. */
export async function seedMenuItems(
  world: Pick<World, "tenantId" | "brandId">,
  count: number,
): Promise<string[]> {
  const categoryId = randomUUID();
  const ids = Array.from({ length: count }, () => randomUUID());
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Kategori Fasilitas', 0)`,
      [categoryId, world.tenantId, world.brandId],
    );
    for (const [index, id] of ids.entries())
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [
          id,
          world.tenantId,
          world.brandId,
          categoryId,
          `Menu ${index} ${short()}`,
        ],
      );
  });
  return ids;
}

/** Order lines for an already seeded order. */
export async function seedOrderItems(
  world: Pick<World, "tenantId">,
  input: {
    orderUlid: string;
    outletId: string;
    menuItemIds: string[];
    businessDate: string;
  },
): Promise<void> {
  await asTenant(world.tenantId, async (client) => {
    for (const menuItemId of input.menuItemIds)
      await client.query(
        `INSERT INTO order_items
           (id, tenant_id, outlet_id, order_id, menu_item_id, name, quantity,
            unit_price_idr, modifiers_total_idr, line_total_idr, fire_status, status,
            reserved_business_date)
         VALUES ($1, $2, $3, $4, $5, 'Menu uji', 1, 20000, 0, 20000, 'fired', 'served', $6)`,
        [
          randomUUID(),
          world.tenantId,
          input.outletId,
          ulidToUuid(input.orderUlid),
          menuItemId,
          input.businessDate,
        ],
      );
  });
}

/** Delivers an event through the facility entitlement consumer like the worker. */
export function deliverEntitlement(
  world: Pick<World, "context">,
  event: EventEnvelope,
): Promise<void> {
  return withTenant(db, world.context, (tx) =>
    deliverFacilityEntitlementEvent(world.context, event, tx, NOW),
  );
}

export type LedgerDbRow = {
  id: string;
  type: "grant" | "redeem" | "cancel" | "expire";
  sessions: number;
  source_type: string;
  source_ref: string;
  rule_id: string | null;
  grant_entry_id: string | null;
  access_ticket_id: string | null;
  expires_at: Date | null;
  facility_id: string;
  outlet_id: string;
  customer_profile_id: string;
};

/** Ledger rows read as the owner (GUCs set), oldest first. */
export async function ledgerRows(
  tenantId: string,
  filter: { customerProfileId?: string; facilityId?: string } = {},
): Promise<LedgerDbRow[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<LedgerDbRow>(
      `SELECT id, type, sessions, source_type, source_ref, rule_id, grant_entry_id, access_ticket_id,
              expires_at, facility_id, outlet_id, customer_profile_id
         FROM entitlement_ledger
        WHERE tenant_id = $1
          AND ($2::uuid IS NULL OR customer_profile_id = $2)
          AND ($3::uuid IS NULL OR facility_id = $3)
        ORDER BY posting_seq`,
      [tenantId, filter.customerProfileId ?? null, filter.facilityId ?? null],
    );
    return rows;
  });
}

export const code = (reason: unknown) =>
  (reason as { code?: string } | undefined)?.code;

/** Error code a promise rejects with; throws when it resolves. */
export async function rejectionCode(
  promise: Promise<unknown>,
): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return code(error) ?? String((error as Error)?.message);
  }
  throw new Error("Expected the call to be rejected, but it succeeded");
}
