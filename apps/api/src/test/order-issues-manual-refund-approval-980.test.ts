// Manual refund on an order issue needs a real, single-use approval (bead
// legend-uyw0v, batch 980 "refund sisa"; PRD v1.7 §6 C `order_issues`, F41, R25,
// AUTH-06). Replaces the R25 stop-gap that refused every `manual_refund` (422).
//
// APPROVAL MECHANISM CHOSEN (map-uyw0v option 2, the POS override):
// - The report body gains `overrideId` (ULID of an approved `pos_overrides` row,
//   nullable; `approvedBy` stays and must equal the override's approver).
// - The override is requested for action "refund", objectType "order_item",
//   objectId = the issue's order item (ULID), outletId = the route outlet,
//   valueIdr = the refunded line total (`order_items.line_total_idr`), by the
//   reporting user, approved by a supervisor with `pos.refund.approve`
//   (PIN method). That is the same `consumeApproval` contract the POS refund
//   uses (order/outlet/tenant/action/amount, requester != approver).
// - Single use: one `pos_order_approval_uses` row per (tenant, override).
//   Guest-order path (no pos_orders row) is legend-5wn1e and out of scope here;
//   every order below has a pos_orders row.
//
// Assumptions where the card is silent:
// - Refund amount = the line total of the item (no amount field on the body).
// - The amount bound is EXACT in this test: an override for a lower value is
//   refused (it does not cover the refund) and an override for a higher value
//   is refused too ("Jangan sampai rugi": the approver approved another
//   amount). The POS `consumeApproval` check is `>=`; if the engineer keeps
//   `>=` the "above" case is a deliberate product decision to take to the CTO.
// - A refusal is any 403, 409 or 422 (the card fixes no code); never 2xx/5xx.
//
// FAIL-FIRST: before the change the body key `overrideId` is a strict-schema
// 422, which would pass a bare "is refused" check. So every refusal test also
// asserts the legit approval for the same line is still unspent afterwards and
// then succeeds (201). That final success is what fails until the feature
// exists, and proves a refused attempt never burns or reuses an approval.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPosOverrideSchema,
  type PosOverrideView,
} from "@starter/shared/access/override";
import {
  createUlid,
  decimal4,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { orderIssueSchema } from "@starter/shared/kitchen";
import { createApp } from "../app.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const short = () => randomUUID().slice(0, 6);
const PIN = "582914";
/** The refunded line: Rp25.000, one cup. */
const LINE_TOTAL = 25_000;

const ids = {
  recorderRole: randomUUID(),
  supervisorRole: randomUUID(),
  otherRole: randomUUID(),
  requesterRoleB: randomUUID(),
  supervisorRoleB: randomUUID(),
  outletB: randomUUID(),
  barA: randomUUID(),
  category: randomUUID(),
};

type Member = { client: ReturnType<typeof agent>; userId: string };

let app: Express;
let tenant: IsolatedTenant;
let tenantB: IsolatedTenant;
let headers: { Host: string };
let recorder: Member; // reports the refund (requester of the override)
let barista: Member; // another reporter with the same permission
let supervisor: Member; // approver, also allowed to report (self-approval case)
let nobody: Member; // no approval permission
let supervisorB: Member; // approver in tenant B
let gramId: string;
let mlId: string;
let cupId: string;
let menuItem: string;

function tenantCtx(forTenant: IsolatedTenant) {
  return establishTenantContext({
    tenantId: tenantIdSchema.parse(forTenant.tenantId),
    brandId: null,
    source: "session",
  });
}

function scopedTenantContext(): ScopedTenantContext {
  return establishScopedTenantContext(tenantCtx(tenant), { kind: "tenant" });
}

let dayCounter = 0;
function nextDate(): string {
  dayCounter += 1;
  return new Date(Date.UTC(2033, 0, 1 + dayCounter)).toISOString().slice(0, 10);
}

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await owner.query<{ id: T }>(sql, params);
  return rows[0]!.id;
}

async function member(
  forTenant: IsolatedTenant,
  roleId: string,
  scope: { type: "tenant" | "outlet" | "station"; id: string | null },
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await assign(forTenant, userId, roleId, scope);
  return { client, userId };
}

async function assign(
  forTenant: IsolatedTenant,
  userId: string,
  roleId: string,
  scope: { type: "tenant" | "outlet" | "station"; id: string | null },
) {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [forTenant.tenantId, userId, roleId, scope.type, scope.id],
  );
}

async function insertRole(
  tenantId: string,
  id: string,
  name: string,
  permissions: string[],
  scopes: string[],
) {
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
    [id, tenantId, name, JSON.stringify(permissions), JSON.stringify(scopes)],
  );
}

/** A latte with a recipe and stock, so the issue cost can be computed. */
async function buildMenuItem(): Promise<string> {
  const location = await one<string>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'bar') RETURNING id",
    [tenant.tenantId, tenant.outletId, `Bar ${short()}`],
  );
  const item = (name: string, uom: string) =>
    one<string>(
      `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
       VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
      [tenant.tenantId, `${name} ${short()}`, uom],
    );
  const beans = await item("Biji Kopi", gramId);
  const milk = await item("Susu", mlId);
  for (const [itemId, quantity, cost] of [
    [beans, "1000.0000", "100.0000"],
    [milk, "10000.0000", "20.0000"],
  ] as const)
    await recordStockMovement(scopedTenantContext(), {
      outletId: outletIdSchema.parse(tenant.outletId),
      locationId: location,
      inventoryItemId: itemId,
      movementType: "receipt",
      quantity: decimal4(quantity),
      unitCostIdr: decimal4(cost),
      batchId: null,
      sourceType: "goods_receipt",
      sourceId: randomUUID(),
      actor: { type: "system" },
    } as never);
  const recipe = await one<string>(
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, NULL, 1, $4, true, $5) RETURNING id`,
    [
      tenant.tenantId,
      tenant.brandId,
      `Latte ${short()}`,
      cupId,
      recorder.userId,
    ],
  );
  for (const [index, [itemId, qty, uom]] of (
    [
      [beans, "18.0000", gramId],
      [milk, "200.0000", mlId],
    ] as const
  ).entries())
    await owner.query(
      `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       VALUES ($1, $2, $3, 'item', $4, $5, $6, 0)`,
      [tenant.tenantId, recipe, index, itemId, qty, uom],
    );
  const menu = await one<string>(
    `INSERT INTO menu_items (tenant_id, brand_id, category_id, name, recipe_id, is_active, media_id, station_id, station_type)
     VALUES ($1, $2, $3, $4, $5, true, $6, $7, 'beverage_bar') RETURNING id`,
    [
      tenant.tenantId,
      tenant.brandId,
      ids.category,
      `Latte ${short()}`,
      recipe,
      randomUUID(),
      ids.barA,
    ],
  );
  await owner.query(
    `INSERT INTO outlet_inventory_settings (tenant_id, outlet_id, recipe_deduction_mode, sale_location_id)
     VALUES ($1, $2, 'real_time', $3)
     ON CONFLICT (tenant_id, outlet_id)
     DO UPDATE SET recipe_deduction_mode = 'real_time', sale_location_id = EXCLUDED.sale_location_id`,
    [tenant.tenantId, tenant.outletId, location],
  );
  return menu;
}

type Line = { itemUlid: string; itemUuid: string };
type Order = { ulid: string; uuid: string; lines: [Line, Line] };

type SeedOptions = {
  /** Order discount; the tender takes the discounted total. */
  discountIdr?: number;
  /** No captured tender: the order is not paid. Default true. */
  paid?: boolean;
  /** Index of a line voided after the sale. */
  voidedLine?: 0 | 1;
  /** A POS refund already paid out on the order. */
  posRefundIdr?: number;
};

/**
 * A completed, paid order with two Rp25.000 lines (less `discountIdr` on the
 * order) and a `pos_orders` row with one captured cash tender.
 */
async function seedOrder(options: SeedOptions = {}): Promise<Order> {
  const ulid = createUlid();
  const uuid = ulidToUuid(ulid);
  const businessDate = nextDate();
  const discountIdr = options.discountIdr ?? 0;
  const totalIdr = LINE_TOTAL * 2 - discountIdr;
  const lines: Line[] = [0, 1].map(() => {
    const itemUlid = createUlid();
    return { itemUlid, itemUuid: ulidToUuid(itemUlid) };
  });
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, $7, 0, 0, 0, $8,
               'completed', $6, now())`,
      [
        uuid,
        tenant.tenantId,
        tenant.outletId,
        `RFA-${randomUUID().slice(0, 12)}`,
        LINE_TOTAL * 2,
        businessDate,
        discountIdr,
        totalIdr,
      ],
    );
    for (const [index, line] of lines.entries())
      await client.query(
        `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
            quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
            fire_status, status, reserved_business_date)
         VALUES ($1, $2, $3, $4, $5, NULL, 'Latte', 1, $6, 0, $6, '[]'::jsonb,
                 'fired', $8, $7)`,
        [
          line.itemUuid,
          tenant.tenantId,
          tenant.outletId,
          uuid,
          menuItem,
          LINE_TOTAL,
          businessDate,
          options.voidedLine === index ? "voided" : "served",
        ],
      );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel)
       VALUES ($1, $2, $3, 'pos')`,
      [uuid, tenant.tenantId, tenant.outletId],
    );
    if (options.paid !== false)
      await client.query(
        `INSERT INTO pos_order_tenders
           (tenant_id, outlet_id, order_id, method, provider, amount_idr, received_idr,
            change_idr, status, requested_at, resolved_at)
         VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, 'captured', now(), now())`,
        [tenant.tenantId, tenant.outletId, uuid, totalIdr],
      );
    if (options.posRefundIdr !== undefined)
      await client.query(
        `INSERT INTO pos_order_refunds (tenant_id, outlet_id, order_id, amount_idr, reason,
            reason_note, lines, requested_by, approved_by, approval_request_id, refunded_at)
         VALUES ($1, $2, $3, $4, 'customer_cancelled', 'Uji refund kasir', $5::jsonb,
                 'kasir-uji', 'supervisor-uji', $6, now())`,
        [
          tenant.tenantId,
          tenant.outletId,
          uuid,
          options.posRefundIdr,
          JSON.stringify([
            {
              method: "cash",
              amountIdr: options.posRefundIdr,
              reference: null,
            },
          ]),
          randomUUID(),
        ],
      );
  });
  return { ulid, uuid, lines: [lines[0]!, lines[1]!] };
}

/**
 * An issue already resolved by a voucher or a swap on the line (ORD-08
 * recovery); FKs to the voucher and replacement item are skipped.
 */
async function seedLineIssue(
  order: Order,
  line: Line,
  status: "open" | "cancelled",
): Promise<void> {
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
         reason_note, reported_by, cost_idr, status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'unfulfillable', 'out_of_stock',
         'Roti habis, menunggu penyelesaian', $6, 0, $7, $8)`,
      [
        randomUUID(),
        tenant.tenantId,
        tenant.outletId,
        order.uuid,
        line.itemUuid,
        randomUUID(),
        status,
        randomUUID(),
      ],
    );
  });
}

async function seedRecoveredLine(
  order: Order,
  line: Line,
  resolution: "voucher" | "swap",
): Promise<void> {
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
         reason_note, reported_by, resolution, voucher_id, replacement_item_id, cost_idr, status,
         idempotency_key, resolved_at)
       VALUES ($1, $2, $3, $4, $5, 'unfulfillable', 'out_of_stock',
         'Roti habis, diganti', $6, $7, $8, $9, 0, 'resolved', $10, now())`,
      [
        randomUUID(),
        tenant.tenantId,
        tenant.outletId,
        order.uuid,
        line.itemUuid,
        randomUUID(),
        resolution,
        resolution === "voucher" ? randomUUID() : null,
        resolution === "swap" ? randomUUID() : null,
        randomUUID(),
      ],
    );
  });
}

/**
 * A rejected manual-refund issue on line 0 whose provider refund is still
 * pending (non-failed): money may have moved for the order (ORD-09).
 */
async function seedForeignOrd09(
  order: Order,
  // true: the issue is a live ORD-09 failed-item manual issue (approval request
  // stored, refund not rejected), not a rejected route one.
  liveOrd09Manual = false,
): Promise<void> {
  const linkId = randomUUID();
  const intentId = randomUUID();
  const issueId = randomUUID();
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
         reason_note, reported_by, resolution, approved_by, cost_idr, status,
         idempotency_key, resolved_at, refund_rejected_at, approval_request_id)
       VALUES ($1, $2, $3, $4, $5, 'unfulfillable', 'out_of_stock',
         'Roti habis, refund manual ditolak', $6, 'manual_refund', $7, 0, 'resolved',
         $8, now(), CASE WHEN $9::boolean THEN NULL ELSE now() END,
         CASE WHEN $9::boolean THEN $10::uuid ELSE NULL END)`,
      [
        issueId,
        tenant.tenantId,
        tenant.outletId,
        order.uuid,
        order.lines[0].itemUuid,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        liveOrd09Manual,
        randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, 50000, 50000, 50000, 'seed')`,
      [
        linkId,
        tenant.tenantId,
        tenant.outletId,
        randomUUID().replaceAll("-", ""),
        `F980-${linkId.slice(0, 8)}`,
      ],
    );
    await client.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key,
          status, paid_at, instructions, expires_at)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', 50000, $5, 'paid', now(),
               '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
      [intentId, tenant.tenantId, tenant.outletId, linkId, `f980-${intentId}`],
    );
    await client.query(
      `INSERT INTO payment_refunds
         (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
          requested_by, approved_by, decided_at, order_issue_id)
       VALUES ($1, $2, $3, $4, 25000, 'Pengembalian dana', 'approved', 'requester', 'approver', now(), $5)`,
      [randomUUID(), tenant.tenantId, tenant.outletId, intentId, issueId],
    );
  });
}

type ApprovalOptions = {
  forTenant?: IsolatedTenant;
  requester?: Member;
  approver?: Member;
  outletId?: string;
  valueIdr?: number;
  objectType?: string;
  objectId: string;
  method?: "supervisor_pin" | "supervisor_phone";
};

/**
 * A supervisor approval (pos_overrides row) for action "refund". Defaults:
 * requested by `recorder`, approved by `supervisor` with PIN, tenant A, the
 * route outlet, the line total.
 */
async function approval(options: ApprovalOptions): Promise<PosOverrideView> {
  const forTenant = options.forTenant ?? tenant;
  const requester = options.requester ?? recorder;
  const approver = options.approver ?? supervisor;
  const { override } = await createPosOverride(
    tenantCtx(forTenant),
    requester.userId,
    createPosOverrideSchema.parse({
      outletId: options.outletId ?? forTenant.outletId,
      action: "refund",
      valueIdr: options.valueIdr ?? LINE_TOTAL,
      reason: "Refund manual item gagal saji",
      objectType: options.objectType ?? "order_item",
      objectId: options.objectId,
      approval:
        options.method === "supervisor_phone"
          ? { method: "supervisor_phone" }
          : {
              method: "supervisor_pin",
              approverUserId: approver.userId,
              pin: PIN,
            },
    }),
    { idempotencyKey: randomUUID() },
  );
  return override;
}

function report(
  who: Member,
  order: Order,
  line: Line,
  patch: Record<string, unknown>,
) {
  return who.client
    .post(`/api/outlets/${tenant.outletId}/orders/${order.ulid}/issues`)
    .set(headers)
    .set(originHeader)
    .send({
      orderItemId: line.itemUlid,
      type: "complaint",
      reason: "complaint",
      reasonNote: "Pelanggan kecewa, refund manual disetujui",
      stationId: ids.barA,
      employeeId: null,
      resolution: "manual_refund",
      voucherId: null,
      approvedBy: supervisor.userId,
      overrideId: null,
      idempotencyKey: `rfa-${randomUUID()}`,
      ...patch,
    });
}

async function issueRows(line: Line): Promise<number> {
  const { rows } = await owner.query(
    "SELECT 1 FROM order_issues WHERE tenant_id = $1 AND order_item_id = $2",
    [tenant.tenantId, line.itemUuid],
  );
  return rows.length;
}

/** How many times an override was spent (single-use ledger). */
async function uses(overrideId: string): Promise<number> {
  const { rows } = await owner.query(
    "SELECT 1 FROM pos_order_approval_uses WHERE override_id = $1",
    [ulidToUuid(overrideId)],
  );
  return rows.length;
}

function expectRefused(status: number) {
  expect([403, 409, 422]).toContain(status);
}

/**
 * The control that makes a refusal test meaningful (see FAIL-FIRST): nothing
 * was recorded or spent, then the legit approval for this very line still
 * refunds it once.
 */
async function expectLegitStillWorks(
  order: Order,
  line: Line,
  good: PosOverrideView,
  spentElsewhere: PosOverrideView[] = [],
) {
  expect(await issueRows(line)).toBe(0);
  expect(await uses(good.id)).toBe(0);
  for (const other of spentElsewhere) expect(await uses(other.id)).toBe(0);
  const res = await report(recorder, order, line, {
    approvedBy: supervisor.userId,
    overrideId: good.id,
  });
  expect(res.status).toBe(201);
  expect(await issueRows(line)).toBe(1);
  expect(await uses(good.id)).toBe(1);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  tenant = await createIsolatedTenant(`rfa-${short()}`);
  tenantB = await createIsolatedTenant(`rfb-${short()}`);
  headers = { Host: tenant.hostname };

  await insertRole(
    tenant.tenantId,
    ids.recorderRole,
    "Pencatat Refund",
    ["kds.remake_comp.record", "pos.refund.request"],
    ["tenant", "outlet", "station"],
  );
  await insertRole(
    tenant.tenantId,
    ids.supervisorRole,
    "Supervisor Refund",
    ["pos.refund.approve", "kds.remake_comp.record", "pos.refund.request"],
    ["tenant", "outlet"],
  );
  // A phone approval opens an approval request, which fails closed
  // (APPROVAL_POLICY_MISSING) without a refund rule: one tier, any amount,
  // decided by the supervisor role.
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, 1)`,
    [tenant.tenantId, ids.supervisorRole],
  );
  await insertRole(
    tenant.tenantId,
    ids.otherRole,
    "Tanpa Refund",
    ["order.view"],
    ["tenant"],
  );
  await insertRole(
    tenantB.tenantId,
    ids.requesterRoleB,
    "Peminta Refund B",
    ["kds.remake_comp.record", "pos.refund.request"],
    ["tenant"],
  );
  await insertRole(
    tenantB.tenantId,
    ids.supervisorRoleB,
    "Supervisor Refund B",
    ["pos.refund.approve"],
    ["tenant"],
  );

  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Refund B', 'Jl. Uji 2', timezone, opening_hours, 'active'
     FROM outlets WHERE tenant_id = $3 AND id = $4`,
    [
      ids.outletB,
      `RB-${short()}`.toUpperCase(),
      tenant.tenantId,
      tenant.outletId,
    ],
  );
  await owner.query(
    `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'Bar A', 'beverage_bar')`,
    [ids.barA, tenant.tenantId, tenant.outletId],
  );

  recorder = await member(
    tenant,
    ids.recorderRole,
    { type: "tenant", id: null },
    "Pencatat Refund",
  );
  barista = await member(
    tenant,
    ids.recorderRole,
    { type: "station", id: ids.barA },
    "Barista Refund",
  );
  supervisor = await member(
    tenant,
    ids.supervisorRole,
    { type: "tenant", id: null },
    "Supervisor Refund",
  );
  nobody = await member(
    tenant,
    ids.otherRole,
    { type: "tenant", id: null },
    "Tanpa Akses Refund",
  );
  supervisorB = await member(
    tenantB,
    ids.supervisorRoleB,
    { type: "tenant", id: null },
    "Supervisor Tenant B",
  );
  // The reporter also works in tenant B, so a tenant B approval differs from a
  // tenant A one by tenant only (same requester).
  await assign(tenantB, recorder.userId, ids.requesterRoleB, {
    type: "tenant",
    id: null,
  });

  for (const [forTenant, who, outletId] of [
    [tenant, supervisor, tenant.outletId],
    [tenant, supervisor, ids.outletB],
    [tenantB, supervisorB, tenantB.outletId],
  ] as const)
    await setStaffPin(
      tenantCtx(forTenant),
      who.userId,
      { outletId, userId: who.userId },
      { pin: PIN },
    );

  const uom = (code: string) =>
    one<string>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [tenant.tenantId, `${code}${short()}`.slice(0, 10)],
    );
  gramId = await uom("g");
  mlId = await uom("ml");
  cupId = await uom("cup");
  await owner.query(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'Refund Uji', 0)",
    [ids.category, tenant.tenantId, tenant.brandId],
  );
  menuItem = await buildMenuItem();
});

afterAll(async () => {
  // order_issues and override rows stay in the disposable database.
});

describe("reportOrderIssue: manual refund with approval", () => {
  it("accepts a manual refund with a valid approval, once, and spends it", async () => {
    const order = await seedOrder();
    const line = order.lines[0];
    const good = await approval({ objectId: line.itemUlid });
    const res = await report(recorder, order, line, {
      approvedBy: supervisor.userId,
      overrideId: good.id,
    });
    expect(res.status).toBe(201);
    const issue = orderIssueSchema.parse(res.body.data);
    expect(issue).toMatchObject({
      type: "complaint",
      resolution: "manual_refund",
      orderId: order.ulid,
      orderItemId: line.itemUlid,
      approvedBy: supervisor.userId,
      reportedBy: recorder.userId,
    });
    expect(await issueRows(line)).toBe(1);
    expect(await uses(good.id)).toBe(1);
  });

  it("a resend of the same idempotency key returns the stored issue, no second refund", async () => {
    const order = await seedOrder();
    const line = order.lines[0];
    const good = await approval({ objectId: line.itemUlid });
    const key = `rfa-replay-${short()}-key`;
    const body = {
      approvedBy: supervisor.userId,
      overrideId: good.id,
      idempotencyKey: key,
    };
    const first = await report(recorder, order, line, body);
    expect(first.status).toBe(201);
    const again = await report(recorder, order, line, body);
    expect(again.status).toBeLessThan(300);
    expect(orderIssueSchema.parse(again.body.data).id).toBe(
      orderIssueSchema.parse(first.body.data).id,
    );
    expect(await issueRows(line)).toBe(1);
    expect(await uses(good.id)).toBe(1);
  });

  it("refuses an approver id with no override (the old R25 stop-gap holds)", async () => {
    const order = await seedOrder();
    const line = order.lines[0];
    const good = await approval({ objectId: line.itemUlid });
    const bare = await report(recorder, order, line, {
      approvedBy: supervisor.userId,
      overrideId: null,
    });
    expectRefused(bare.status);
    await expectLegitStillWorks(order, line, good);
  });

  it("refuses a forged override id, an unknown one and a pending phone approval", async () => {
    const order = await seedOrder();
    const line = order.lines[0];
    const good = await approval({ objectId: line.itemUlid });
    // Never existed.
    const forged = await report(recorder, order, line, {
      approvedBy: supervisor.userId,
      overrideId: createUlid(),
    });
    expectRefused(forged.status);
    // Asked from a supervisor's phone but not approved yet.
    const pending = await approval({
      objectId: line.itemUlid,
      method: "supervisor_phone",
    });
    const notApproved = await report(recorder, order, line, {
      approvedBy: supervisor.userId,
      overrideId: pending.id,
    });
    expectRefused(notApproved.status);
    await expectLegitStillWorks(order, line, good, [pending]);
  });

  it("refuses when approvedBy is not the person who approved the override", async () => {
    const order = await seedOrder();
    const line = order.lines[0];
    const good = await approval({ objectId: line.itemUlid });
    const wrongApprover = await report(recorder, order, line, {
      approvedBy: nobody.userId,
      overrideId: good.id,
    });
    expectRefused(wrongApprover.status);
    const selfNamed = await report(recorder, order, line, {
      approvedBy: recorder.userId,
      overrideId: good.id,
    });
    expectRefused(selfNamed.status);
    await expectLegitStillWorks(order, line, good);
  });
});

describe("reportOrderIssue: an approval cannot be reused", () => {
  it("a spent approval cannot refund the same line again under a new key", async () => {
    const order = await seedOrder();
    const line = order.lines[0];
    const good = await approval({ objectId: line.itemUlid });
    const first = await report(recorder, order, line, {
      approvedBy: supervisor.userId,
      overrideId: good.id,
    });
    expect(first.status).toBe(201);
    const second = await report(recorder, order, line, {
      approvedBy: supervisor.userId,
      overrideId: good.id,
      idempotencyKey: `rfa-${randomUUID()}`,
    });
    expectRefused(second.status);
    expect(await issueRows(line)).toBe(1);
    expect(await uses(good.id)).toBe(1);
  });

  it("a spent approval cannot refund a second line of the same order", async () => {
    const order = await seedOrder();
    const [first, second] = order.lines;
    const good = await approval({ objectId: first.itemUlid });
    expect(
      (
        await report(recorder, order, first, {
          approvedBy: supervisor.userId,
          overrideId: good.id,
        })
      ).status,
    ).toBe(201);
    const reuse = await report(recorder, order, second, {
      approvedBy: supervisor.userId,
      overrideId: good.id,
    });
    expectRefused(reuse.status);
    expect(await issueRows(second)).toBe(0);
    expect(await uses(good.id)).toBe(1);
  });

  it("an approval for line 1 cannot refund line 2 even when unspent", async () => {
    const order = await seedOrder();
    const [first, second] = order.lines;
    const forFirst = await approval({ objectId: first.itemUlid });
    const wrongLine = await report(recorder, order, second, {
      approvedBy: supervisor.userId,
      overrideId: forFirst.id,
    });
    expectRefused(wrongLine.status);
    expect(await issueRows(second)).toBe(0);
    // Still unspent: it refunds its own line.
    await expectLegitStillWorks(order, first, forFirst);
  });

  it("two parallel reports on one approval refund at most once", async () => {
    const order = await seedOrder();
    const line = order.lines[0];
    const good = await approval({ objectId: line.itemUlid });
    const results = await Promise.all(
      [0, 1].map(() =>
        report(recorder, order, line, {
          approvedBy: supervisor.userId,
          overrideId: good.id,
          idempotencyKey: `rfa-${randomUUID()}`,
        }),
      ),
    );
    expect(results.filter((res) => res.status === 201)).toHaveLength(1);
    for (const res of results)
      if (res.status !== 201) expectRefused(res.status);
    expect(await issueRows(line)).toBe(1);
    expect(await uses(good.id)).toBe(1);
  });
});

describe("reportOrderIssue: approval bound to order, outlet, tenant", () => {
  it("refuses an approval made for another order's line", async () => {
    const order = await seedOrder();
    const other = await seedOrder();
    const line = order.lines[0];
    const good = await approval({ objectId: line.itemUlid });
    const forOther = await approval({ objectId: other.lines[0].itemUlid });
    const res = await report(recorder, order, line, {
      approvedBy: supervisor.userId,
      overrideId: forOther.id,
    });
    expectRefused(res.status);
    await expectLegitStillWorks(order, line, good, [forOther]);
  });

  it("refuses an approval for the whole order or another object type", async () => {
    const order = await seedOrder();
    const line = order.lines[0];
    const good = await approval({ objectId: line.itemUlid });
    const wholeOrder = await approval({
      objectType: "order",
      objectId: order.ulid,
      valueIdr: LINE_TOTAL * 2,
    });
    const res = await report(recorder, order, line, {
      approvedBy: supervisor.userId,
      overrideId: wholeOrder.id,
    });
    expectRefused(res.status);
    await expectLegitStillWorks(order, line, good, [wholeOrder]);
  });

  it("refuses an approval granted for another outlet", async () => {
    const order = await seedOrder();
    const line = order.lines[0];
    const good = await approval({ objectId: line.itemUlid });
    const otherOutlet = await approval({
      objectId: line.itemUlid,
      outletId: ids.outletB,
    });
    const res = await report(recorder, order, line, {
      approvedBy: supervisor.userId,
      overrideId: otherOutlet.id,
    });
    expectRefused(res.status);
    await expectLegitStillWorks(order, line, good, [otherOutlet]);
  });

  it("refuses an approval granted in another tenant", async () => {
    const order = await seedOrder();
    const line = order.lines[0];
    const good = await approval({ objectId: line.itemUlid });
    const otherTenant = await approval({
      forTenant: tenantB,
      approver: supervisorB,
      objectId: line.itemUlid,
    });
    const res = await report(recorder, order, line, {
      approvedBy: supervisorB.userId,
      overrideId: otherTenant.id,
    });
    expectRefused(res.status);
    // The foreign override is untouched: tenant B's ledger stays empty.
    const { rows } = await owner.query(
      "SELECT 1 FROM pos_order_approval_uses WHERE override_id = $1",
      [ulidToUuid(otherTenant.id)],
    );
    expect(rows).toHaveLength(0);
    await expectLegitStillWorks(order, line, good);
  });

  it("refuses an approval that another user requested", async () => {
    const order = await seedOrder();
    const line = order.lines[0];
    const good = await approval({ objectId: line.itemUlid });
    const requestedByBarista = await approval({
      objectId: line.itemUlid,
      requester: barista,
    });
    // `recorder` reports with `barista`'s approval.
    const res = await report(recorder, order, line, {
      approvedBy: supervisor.userId,
      overrideId: requestedByBarista.id,
    });
    expectRefused(res.status);
    await expectLegitStillWorks(order, line, good, [requestedByBarista]);
  });
});

describe("reportOrderIssue: approval bound to the amount", () => {
  it("refuses an approval for less than the refunded line total", async () => {
    const order = await seedOrder();
    const line = order.lines[0];
    const good = await approval({ objectId: line.itemUlid });
    const below = await approval({
      objectId: line.itemUlid,
      valueIdr: LINE_TOTAL - 1,
    });
    const res = await report(recorder, order, line, {
      approvedBy: supervisor.userId,
      overrideId: below.id,
    });
    expectRefused(res.status);
    await expectLegitStillWorks(order, line, good, [below]);
  });

  // Assumption (see top): the bound is exact, not ">=".
  it("refuses an approval for more than the refunded line total", async () => {
    const order = await seedOrder();
    const line = order.lines[0];
    const good = await approval({ objectId: line.itemUlid });
    const above = await approval({
      objectId: line.itemUlid,
      valueIdr: LINE_TOTAL + 1,
    });
    const res = await report(recorder, order, line, {
      approvedBy: supervisor.userId,
      overrideId: above.id,
    });
    expectRefused(res.status);
    await expectLegitStillWorks(order, line, good, [above]);
  });
});

describe("reportOrderIssue: requester and approver must differ", () => {
  it("refuses when the reporter is the approver of the override", async () => {
    const order = await seedOrder();
    const line = order.lines[0];
    const good = await approval({ objectId: line.itemUlid });
    // The supervisor may record issues, but cannot report on an approval that
    // they granted to someone else, nor approve their own report.
    const approverReports = await report(supervisor, order, line, {
      approvedBy: supervisor.userId,
      overrideId: good.id,
    });
    expectRefused(approverReports.status);
    await expectLegitStillWorks(order, line, good);
  });

  it("refuses a different reporter than the one who asked for the approval", async () => {
    const order = await seedOrder();
    const line = order.lines[0];
    const good = await approval({ objectId: line.itemUlid });
    const otherReporter = await report(barista, order, line, {
      approvedBy: supervisor.userId,
      overrideId: good.id,
    });
    expectRefused(otherReporter.status);
    await expectLegitStillWorks(order, line, good);
  });
});

describe("reportOrderIssue: manual refund guards (legend-uyw0v, 980)", () => {
  it("refuses a manual refund of a voided line and spends nothing", async () => {
    const order = await seedOrder({ voidedLine: 1 });
    const [live, voided] = order.lines;
    const forVoided = await approval({ objectId: voided.itemUlid });
    const res = await report(recorder, order, voided, {
      approvedBy: supervisor.userId,
      overrideId: forVoided.id,
    });
    expectRefused(res.status);
    expect(await issueRows(voided)).toBe(0);
    expect(await uses(forVoided.id)).toBe(0);
    // The live line of the same order still refunds.
    const good = await approval({ objectId: live.itemUlid });
    await expectLegitStillWorks(order, live, good);
  });

  it("refuses a manual refund on an order that was not paid", async () => {
    const order = await seedOrder({ paid: false });
    const line = order.lines[0];
    const unpaid = await approval({ objectId: line.itemUlid });
    const res = await report(recorder, order, line, {
      approvedBy: supervisor.userId,
      overrideId: unpaid.id,
    });
    expectRefused(res.status);
    expect(await issueRows(line)).toBe(0);
    expect(await uses(unpaid.id)).toBe(0);
  });

  it("refuses a second manual refund of one line, whatever the issue type", async () => {
    const order = await seedOrder();
    const line = order.lines[0];
    const first = await approval({ objectId: line.itemUlid });
    expect(
      (
        await report(recorder, order, line, {
          approvedBy: supervisor.userId,
          overrideId: first.id,
        })
      ).status,
    ).toBe(201);
    const viaRemake = await approval({ objectId: line.itemUlid });
    const remake = await report(recorder, order, line, {
      type: "remake",
      reason: "quality",
      employeeId: recorder.userId,
      approvedBy: supervisor.userId,
      overrideId: viaRemake.id,
    });
    expectRefused(remake.status);
    const viaComplaint = await approval({ objectId: line.itemUlid });
    const complaint = await report(recorder, order, line, {
      approvedBy: supervisor.userId,
      overrideId: viaComplaint.id,
    });
    expectRefused(complaint.status);
    expect(await issueRows(line)).toBe(1);
    expect(await uses(first.id)).toBe(1);
    expect(await uses(viaRemake.id)).toBe(0);
    expect(await uses(viaComplaint.id)).toBe(0);
  });

  it("the database itself refuses a second live manual refund of one line", async () => {
    const order = await seedOrder();
    const line = order.lines[0];
    const good = await approval({ objectId: line.itemUlid });
    expect(
      (
        await report(recorder, order, line, {
          approvedBy: supervisor.userId,
          overrideId: good.id,
        })
      ).status,
    ).toBe(201);
    await expect(
      owner.query(
        `INSERT INTO order_issues (tenant_id, outlet_id, order_id, order_item_id, type, reason,
            reason_note, reported_by, resolution, approved_by, cost_idr, status, idempotency_key, resolved_at)
         VALUES ($1, $2, $3, $4, 'complaint', 'complaint', 'Pelanggan kecewa, refund manual disetujui',
            $5, 'manual_refund', $6, 0, 'resolved', $7, now())`,
        [
          tenant.tenantId,
          tenant.outletId,
          order.uuid,
          line.itemUuid,
          recorder.userId,
          supervisor.userId,
          `seed-${randomUUID()}`,
        ],
      ),
    ).rejects.toMatchObject({
      constraint: "order_issues_manual_refund_once_idx",
    });
  });

  it("binds the approval to what the guest paid on a discounted order", async () => {
    // Rp10.000 off the Rp50.000 bill: each Rp25.000 line was paid at Rp20.000.
    const order = await seedOrder({ discountIdr: 10_000 });
    const [first, second] = order.lines;
    const gross = await approval({ objectId: first.itemUlid });
    const sticker = await report(recorder, order, first, {
      approvedBy: supervisor.userId,
      overrideId: gross.id,
    });
    expectRefused(sticker.status);
    const paid = await approval({ objectId: first.itemUlid, valueIdr: 20_000 });
    await expectLegitStillWorks(order, first, paid, [gross]);
    // The second line takes the rest of the bill, not another Rp25.000.
    const secondGross = await approval({ objectId: second.itemUlid });
    expectRefused(
      (
        await report(recorder, order, second, {
          approvedBy: supervisor.userId,
          overrideId: secondGross.id,
        })
      ).status,
    );
    const secondPaid = await approval({
      objectId: second.itemUlid,
      valueIdr: 20_000,
    });
    await expectLegitStillWorks(order, second, secondPaid, [secondGross]);
  });

  it("refuses a manual refund on an order that already has a POS refund (exclusive per order); nothing spent", async () => {
    // Rp5.000 refunded at the till is enough: the two paths never mix.
    const order = await seedOrder({ posRefundIdr: 5_000 });
    const line = order.lines[0];
    const over = await approval({ objectId: line.itemUlid });
    const res = await report(recorder, order, line, {
      approvedBy: supervisor.userId,
      overrideId: over.id,
    });
    expect(res.status).toBe(409);
    expect(await issueRows(line)).toBe(0);
    expect(await uses(over.id)).toBe(0);
    // Control: the same line of an order without a POS refund refunds.
    const clean = await seedOrder();
    const good = await approval({ objectId: clean.lines[0].itemUlid });
    await expectLegitStillWorks(clean, clean.lines[0], good);
  });

  it("refuses a manual refund when a rejected issue's provider refund already moved money on the order", async () => {
    const order = await seedOrder();
    await seedForeignOrd09(order);
    const line = order.lines[1];
    const over = await approval({ objectId: line.itemUlid });
    const res = await report(recorder, order, line, {
      approvedBy: supervisor.userId,
      overrideId: over.id,
    });
    expect(res.status).toBe(409);
    expect(await issueRows(line)).toBe(0);
    expect(await uses(over.id)).toBe(0);
  });

  it("refuses a manual refund when a live ORD-09 manual issue's provider refund moved money on the order; nothing spent", async () => {
    const order = await seedOrder();
    await seedForeignOrd09(order, true);
    const line = order.lines[1];
    const over = await approval({ objectId: line.itemUlid });
    const res = await report(recorder, order, line, {
      approvedBy: supervisor.userId,
      overrideId: over.id,
    });
    expect(res.status).toBe(409);
    expect(await issueRows(line)).toBe(0);
    expect(await uses(over.id)).toBe(0);
  });

  it("refuses a manual refund of a line already settled by a voucher or a swap; nothing spent", async () => {
    const order = await seedOrder();
    const [voucherLine, swapLine] = order.lines;
    await seedRecoveredLine(order, voucherLine, "voucher");
    await seedRecoveredLine(order, swapLine, "swap");
    for (const line of [voucherLine, swapLine]) {
      const over = await approval({ objectId: line.itemUlid });
      const res = await report(recorder, order, line, {
        approvedBy: supervisor.userId,
        overrideId: over.id,
      });
      expect(res.status).toBe(409);
      expect(await uses(over.id)).toBe(0);
    }
    // Control: a line without a recovery refunds.
    const clean = await seedOrder();
    const good = await approval({ objectId: clean.lines[0].itemUlid });
    await expectLegitStillWorks(clean, clean.lines[0], good);
  });

  it("refuses a manual refund of a line with an open (or settled) failed-item issue; nothing spent; a cancelled one does not block", async () => {
    const order = await seedOrder();
    const [openLine, cancelledLine] = order.lines;
    await seedLineIssue(order, openLine, "open");
    await seedLineIssue(order, cancelledLine, "cancelled");
    const over = await approval({ objectId: openLine.itemUlid });
    const refused = await report(recorder, order, openLine, {
      approvedBy: supervisor.userId,
      overrideId: over.id,
    });
    expect(refused.status).toBe(409);
    expect(await uses(over.id)).toBe(0);
    // The refused line still holds only its seeded issue.
    expect(await issueRows(openLine)).toBe(1);
    // Control: the cancelled issue gave nothing, the line refunds. (Not
    // expectLegitStillWorks: that helper expects a line with no issue row, and
    // this line keeps its seeded cancelled one next to the new refund.)
    expect(await issueRows(cancelledLine)).toBe(1);
    const good = await approval({ objectId: cancelledLine.itemUlid });
    expect(await uses(good.id)).toBe(0);
    const res = await report(recorder, order, cancelledLine, {
      approvedBy: supervisor.userId,
      overrideId: good.id,
    });
    expect(res.status).toBe(201);
    expect(await issueRows(cancelledLine)).toBe(2);
    expect(await uses(good.id)).toBe(1);
  });

  it("checks the line for other compensation only after the order row lock (code structure)", async () => {
    const source = readFileSync(
      new URL("../services/order-issue-manual-refund.ts", import.meta.url),
      "utf8",
    );
    const body = source.slice(
      source.indexOf("export async function assertLineHasNoOtherCompensation"),
    );
    expect(body.indexOf('.for("update")')).toBeGreaterThan(-1);
    expect(body.indexOf('.for("update")')).toBeLessThan(
      body.indexOf("orderIssues.status"),
    );
    const route = readFileSync(
      new URL("../services/order-issues.service.ts", import.meta.url),
      "utf8",
    );
    // No voucher/swap lookup is left ahead of the locking helper.
    expect(route).not.toContain('inArray(orderIssues.resolution, ["voucher"');
    expect(route.indexOf("assertLineHasNoOtherCompensation(")).toBeLessThan(
      route.indexOf("manualRefundAmountIdr(tx"),
    );
  });

  it("two live manual refunds of one order both fit while together within what it took in", async () => {
    const order = await seedOrder();
    const [first, second] = order.lines;
    const one = await approval({ objectId: first.itemUlid });
    await expectLegitStillWorks(order, first, one);
    const two = await approval({ objectId: second.itemUlid });
    await expectLegitStillWorks(order, second, two);
  });
});
