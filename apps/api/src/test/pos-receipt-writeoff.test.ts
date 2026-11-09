// Audited write-off of a lost receipt number (bead legend-0hzqw).
//
// Since legend-6b0ld Tutup Hari refuses (RECEIPT_SEQUENCE_GAP) while any run of
// the outlet misses an ordinal, with no way out. The tenant owner may mark one
// number (prefix + ordinal) as permanently lost, with a reason; gap checks then
// count it as present and the shift report lists it under `writtenOff`.
//
// Assumptions (the brief is the spec; no document exists yet):
// - POST /api/outlets/:outletId/pos/receipt-writeoffs answers 201 { data }; GET
//   on the same path answers 200 { data: [...] } newest first. The DTO fields
//   are id, outletId, prefix, sequenceNumber, number, reason, writtenOffBy,
//   createdAt.
// - "Owner" is a tenant member holding the OWNER ROLE TEMPLATE (legend-l56xd:
//   only the owner template may use pos.receipt.writeoff; a custom role that
//   holds the code is refused 403 PERMISSION_DENIED even for a tenant admin
//   path). An isolated tenant has no templates, so the test inserts one owner
//   template row per tenant (mfa_required false, like the other POS tests),
//   holding exactly that permission; the manager role holds only pos.day.close
//   and must be refused (403).
// - POST needs a second factor verified in the last 5 minutes: a session with
//   mfa_verified_at older than that answers 401 REAUTH_REQUIRED, one without any
//   verification 403 MFA_REQUIRED. GET needs neither, but is owner only and,
//   like POST, refused on the edge (409).
// - A body that fails validation (reason shorter than 10 characters) answers
//   422 VALIDATION_ERROR; an outlet of another tenant answers 403 or 404 (either hides it).
// - The audit row is read from audit_logs: event.action, actorId, reason and
//   maskedChanges.after carry outletId, prefix, sequenceNumber and number.
// - POST also needs a session whose second factor was verified (AUTH-05):
//   without it the API answers 403 MFA_REQUIRED (the status AccessError maps
//   to, as in payment-refund-manual-settle.test.ts) and writes nothing. GET
//   does not need it. Members that POST are verified with verifySessionMfa.
// - A receipt that arrives later for a written-off number makes the write-off
//   drop out of the shift report's writtenOff list and the gap count; the
//   audit row stays.
// - The edge refusal is 409 (CONFLICT) and is toggled through
//   setEdgeRuntimeStateForTests, like pos-day-receipt-gaps.test.ts.
// - A user holding the permission only through an outlet-scoped assignment is
//   refused (403 or 404) on another outlet of the same tenant.
// - An open shift does not block the close; as in pos-receipt-gaps-prefix.test.ts
//   the shift is opened (owner SQL) only to read the shift report.
// - The DB backstop (BEFORE INSERT trigger) refuses a number that has a receipt
//   or lies past last_number with SQLSTATE 23514, like the append-only trigger.
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS in a fresh
// isolated tenant; helpers are copied from pos-day-close-all-gaps.test.ts.
// Each scenario uses its own outlet.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/pos-receipt-writeoff.test.ts" pnpm test

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import { tenantIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { formatReceiptNumber } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import {
  setPosOutletReceiptGapsPort,
  setPosReceiptGapsPort,
} from "../services/pos-shift-ports.ts";
import {
  receiptGapsForDevice,
  receiptGapsForOutlet,
  receiptGapsForOutletFast,
} from "../services/pos-receipt.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;
const SEED_SNAPSHOT = JSON.stringify({
  outletName: "Cafe Legend Senopati",
  outletAddress: "Jl. Kopi Legenda No. 12, Jakarta Selatan",
  legalName: null,
  npwpLast4: null,
});

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  cashierRole: randomUUID(),
  managerRole: randomUUID(),
  ownerRole: randomUUID(),
  customWriteoffRole: randomUUID(),
  otherOwnerRole: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let manager: Member;
let ownerA: Member;
// An owner whose session never verified a second factor.
let ownerNoMfa: Member;
// A second tenant whose owner must never reach tenant A.
let otherTenant: IsolatedTenant;
let otherHeaders: { Host: string };
let ownerB: Member;

const errorCode = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;
// Assumption: the API returns the message as body.error.message (like the code).
const errorMessage = (body: {
  error?: { message?: string };
  message?: string;
}) => body.error?.message ?? body.message;
const holeMessage = (...numbers: string[]) =>
  `Ada nomor struk yang hilang di outlet ini: ${numbers.join(", ")}.`;

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

async function member(
  roleId: string,
  label: string,
  tenantId: string = tenant.tenantId,
  options: {
    /** Mark the session's second factor as verified (default false). */
    mfa?: boolean;
    /** Assign the role to one outlet instead of the whole tenant. */
    outletId?: string;
  } = {},
): Promise<Member> {
  const client = agent(app);
  const email = await signUp(client, label);
  if (options.mfa) await verifySessionMfa(email);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenantId,
      userId,
      roleId,
      options.outletId ? "outlet" : "tenant",
      options.outletId ?? null,
    ],
  );
  return { client, userId };
}

/** An outlet with its own price list, so a draft can be made there. */
async function freshOutlet(): Promise<string> {
  const outletId = randomUUID();
  const priceListId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Cafe Legend Senopati', 'Jl. Kopi Legenda No. 12, Jakarta Selatan', 'Asia/Jakarta', $6, 'active')`,
    [
      outletId,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `G${outletId.slice(0, 8)}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [priceListId, tenant.tenantId, outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, priceListId, ids.kopi, KOPI_IDR],
    );
  });
  return outletId;
}

async function draftOrder(outletId: string): Promise<string> {
  const created = await cashier.client
    .post(`/api/outlets/${encodeURIComponent(outletId)}/pos/orders`)
    .set(headers)
    .set(originHeader)
    .send({
      idempotencyKey: randomUUID(),
      channel: "pos",
      serviceType: "takeaway",
      items: [{ menuItemId: ids.kopi, quantity: 1, modifierIds: [] }],
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

function closeDay(outletId: string, businessDate: string) {
  return manager.client
    .post(`/api/outlets/${encodeURIComponent(outletId)}/pos/day/close`)
    .set(headers)
    .set(originHeader)
    .send({
      businessDate,
      inventoryDeduction: false,
      idempotencyKey: randomUUID(),
    });
}

async function dailyCloseCount(outletId: string): Promise<number> {
  const { rows } = await owner.query(
    `SELECT 1 FROM pos_daily_closes WHERE tenant_id = $1 AND outlet_id = $2`,
    [tenant.tenantId, outletId],
  );
  return rows.length;
}

beforeAll(async () => {
  app = createApp();
  // Same wiring as app.ts (legend-ain0); other test files reset it to null.
  setPosReceiptGapsPort(receiptGapsForDevice);
  setPosOutletReceiptGapsPort((tx, context, { outletId }) =>
    receiptGapsForOutletFast(tx, context, outletId),
  );
  tenant = await createIsolatedTenant(`wo-${randomUUID().slice(0, 6)}`);
  otherTenant = await createIsolatedTenant(`wob-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  otherHeaders = { Host: otherTenant.hostname };
  // [id, tenant, name, permissions, owner template?]
  const roles: [string, string, string, string[], boolean][] = [
    [
      ids.cashierRole,
      tenant.tenantId,
      "Kasir Write-off",
      ["order.view", "pos.sale.create", "shift.cash.operate"],
      false,
    ],
    [
      ids.managerRole,
      tenant.tenantId,
      "Manajer Write-off",
      ["pos.day.close"],
      false,
    ],
    // The owner TEMPLATE (unique per tenant). It also allows outlet scope, for
    // the outlet-scoped assignment test below.
    [
      ids.ownerRole,
      tenant.tenantId,
      "Pemilik Write-off",
      ["pos.receipt.writeoff"],
      true,
    ],
    [
      ids.otherOwnerRole,
      otherTenant.tenantId,
      "Pemilik Tenant Lain",
      ["pos.receipt.writeoff"],
      true,
    ],
    // A custom role that holds the code (what a tenant admin can create).
    [
      ids.customWriteoffRole,
      tenant.tenantId,
      "Kustom Pegang Write-off",
      ["pos.receipt.writeoff"],
      false,
    ],
  ];
  for (const [id, tenantId, name, permissions, isOwnerTemplate] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, $4, $5, $6, false, '["tenant","outlet"]')`,
      [
        id,
        tenantId,
        name,
        isOwnerTemplate,
        isOwnerTemplate ? "owner" : null,
        JSON.stringify(permissions),
      ],
    );
  cashier = await member(ids.cashierRole, "Kasir Writeoff");
  manager = await member(ids.managerRole, "Manajer Writeoff");
  ownerA = await member(ids.ownerRole, "Pemilik Writeoff", tenant.tenantId, {
    mfa: true,
  });
  ownerNoMfa = await member(ids.ownerRole, "Pemilik Tanpa 2FA");
  ownerB = await member(
    ids.otherOwnerRole,
    "Pemilik Lain",
    otherTenant.tenantId,
    { mfa: true },
  );
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Write-off Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    // A draft needs published tax settings and a rule for the item.
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-WO', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
  });
}, 120_000);

afterAll(async () => {
  setPosReceiptGapsPort(null);
  setPosOutletReceiptGapsPort(null);
  // Final orders and audit rows are immutable, so the isolated tenants stay in
  // the disposable database; give them a valid creator for the tenant list.
  for (const tenantId of [tenant.tenantId, otherTenant.tenantId])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      tenantId,
      randomUUID(),
    ]);
  await owner.end();
});
type RunSeed = {
  prefix: string;
  lastNumber: number;
  present: number[];
  /** Offset in minutes before now, so runs have a stable age order. */
  ageMinutes: number;
  /** Set for a retired run; omitted for the current run. */
  retired?: { reason: string; edgeReportedNumber: number };
};

/**
 * Owner-side seed: one device (or the outlet-owned cloud sequence when
 * `deviceId` is the outlet id) with several runs. Every receipt gets its own
 * zero-value completed order. `daysBefore` moves those orders to an earlier
 * business date, so the device has no activity on the closing date.
 */
async function seedDevice(
  outletId: string,
  runs: RunSeed[],
  options: { deviceId?: string; daysBefore?: number; revoked?: boolean } = {},
): Promise<{ deviceId: string; businessDate: string }> {
  const deviceId = options.deviceId ?? randomUUID();
  const daysBefore = options.daysBefore ?? 0;
  const total = runs.reduce((sum, run) => sum + run.present.length, 0);
  const orderIds: string[] = [];
  for (let n = 0; n < total; n += 1) orderIds.push(await draftOrder(outletId));
  let next = 0;
  const businessDate = await asOwnerTenant(tenant.tenantId, async (client) => {
    let date = "";
    if (options.revoked)
      await client.query(
        `INSERT INTO devices (id, tenant_id, outlet_id, type, label, status, revoked_at)
         VALUES ($1, $2, $3, 'pos', 'Kasir Dicabut', 'revoked', now())`,
        [deviceId, tenant.tenantId, outletId],
      );
    for (const run of runs) {
      const sequenceId = randomUUID();
      await client.query(
        `INSERT INTO receipt_sequences
           (id, tenant_id, outlet_id, device_id, prefix, last_number,
            edge_reported_number, retired_at, retired_reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 CASE WHEN $8::text IS NULL THEN NULL ELSE now() END,
                 $8::text,
                 now() - ($9::int * interval '1 minute'))`,
        [
          sequenceId,
          tenant.tenantId,
          outletId,
          deviceId,
          run.prefix,
          run.lastNumber,
          run.retired?.edgeReportedNumber ?? 0,
          run.retired?.reason ?? null,
          run.ageMinutes,
        ],
      );
      for (const ordinal of run.present) {
        const orderUuid = ulidToUuid(orderIds[next]!);
        next += 1;
        await client.query(
          `UPDATE pos_orders SET device_id = $3 WHERE tenant_id = $1 AND order_id = $2::uuid`,
          [tenant.tenantId, orderUuid, deviceId],
        );
        const done = await client.query<{ business_date: string }>(
          `UPDATE orders
              SET subtotal_idr = 0, discount_idr = 0, service_charge_idr = 0,
                  tax_idr = 0, rounding_idr = 0, total_idr = 0, status = 'completed',
                  business_date = business_date - $3::int
            WHERE tenant_id = $1 AND id = $2::uuid
            RETURNING business_date::text AS business_date`,
          [tenant.tenantId, orderUuid, daysBefore],
        );
        date = done.rows[0]!.business_date;
        await client.query(
          `INSERT INTO pos_receipts
             (tenant_id, outlet_id, order_id, sequence_id, device_id, number, sequence_number, status, issued_at, outlet_snapshot)
           VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, 'issued', now(), $8::jsonb)`,
          [
            tenant.tenantId,
            outletId,
            orderUuid,
            sequenceId,
            deviceId,
            formatReceiptNumber(run.prefix, ordinal),
            ordinal,
            SEED_SNAPSHOT,
          ],
        );
      }
    }
    return date;
  });
  return { deviceId, businessDate };
}

/** The active device: one clean run, completed orders on the closing date. */
function seedActiveDevice(outletId: string) {
  return seedDevice(outletId, [
    { prefix: "AC", lastNumber: 2, present: [1, 2], ageMinutes: 10 },
  ]);
}

/** An open shift of the device (owner SQL; the shift report reads it). */
async function openShift(
  outletId: string,
  deviceId: string,
  businessDate: string,
): Promise<string> {
  const shiftId = randomUUID();
  await owner.query(
    `INSERT INTO pos_shifts
       (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
        opened_at, opening_float_idr, open_key, open_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', now(), 100000, $7, $8)`,
    [
      shiftId,
      tenant.tenantId,
      outletId,
      deviceId,
      cashier.userId,
      businessDate,
      randomUUID(),
      "0".repeat(64),
    ],
  );
  return shiftId;
}

async function shiftReportGaps(
  outletId: string,
  deviceId: string,
  businessDate: string,
) {
  const shiftId = await openShift(outletId, deviceId, businessDate);
  const report = await cashier.client
    .get(
      `/api/outlets/${encodeURIComponent(outletId)}/pos/shifts/${encodeURIComponent(shiftId)}`,
    )
    .set(headers)
    .set(originHeader);
  expect(report.status, JSON.stringify(report.body)).toBe(200);
  return report.body.data.receiptGaps as unknown;
}

const writeoffPath = (outletId: string) =>
  `/api/outlets/${encodeURIComponent(outletId)}/pos/receipt-writeoffs`;

function writeOff(
  who: Member,
  outletId: string,
  body: { prefix: string; sequenceNumber: number; reason: string },
  host: { Host: string } = headers,
) {
  return who.client
    .post(writeoffPath(outletId))
    .set(host)
    .set(originHeader)
    .send(body);
}

function listWriteOffs(
  who: Member,
  outletId: string,
  host: { Host: string } = headers,
) {
  return who.client.get(writeoffPath(outletId)).set(host).set(originHeader);
}

async function writeoffRows(outletId: string) {
  const { rows } = await owner.query<{
    id: string;
    prefix: string;
    sequence_number: number;
    reason: string;
  }>(
    `SELECT id, prefix, sequence_number, reason FROM receipt_number_writeoffs
      WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY sequence_number`,
    [tenant.tenantId, outletId],
  );
  return rows;
}

async function sequenceIdOf(outletId: string, prefix: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM receipt_sequences
      WHERE tenant_id = $1 AND outlet_id = $2 AND prefix = $3`,
    [tenant.tenantId, outletId, prefix],
  );
  return rows[0]!.id;
}

const REASON = "Struk hilang bersama printer yang rusak";

/** An outlet with an idle device whose retired run `prefix` misses #2. */
async function outletWithHole(prefix: string) {
  const outletId = await freshOutlet();
  const active = await seedActiveDevice(outletId);
  const idle = await seedDevice(
    outletId,
    [
      {
        prefix,
        lastNumber: 3,
        present: [1, 3],
        ageMinutes: 60,
        retired: { reason: "claim_rotated", edgeReportedNumber: 0 },
      },
    ],
    { daysBefore: 1 },
  );
  return { outletId, closingDate: active.businessDate, idle };
}

/** Sequences of the outlet that miss ordinals (what the outlet port reports). */
async function outletGaps(outletId: string) {
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
  return withTenant(db, context, (tx) =>
    receiptGapsForOutletFast(tx as never, context, outletId),
  );
}

/**
 * Owner SQL: a receipt for `ordinal` arrives after the fact (a device synced
 * late), on the run `prefix` of the outlet. Same shape as seedDevice's rows.
 */
async function insertLateReceipt(
  outletId: string,
  prefix: string,
  ordinal: number,
  daysBefore = 1,
) {
  const orderId = await draftOrder(outletId);
  const orderUuid = ulidToUuid(orderId);
  const { rows } = await owner.query<{ id: string; device_id: string }>(
    `SELECT id, device_id FROM receipt_sequences
      WHERE tenant_id = $1 AND outlet_id = $2 AND prefix = $3`,
    [tenant.tenantId, outletId, prefix],
  );
  const sequence = rows[0]!;
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `UPDATE pos_orders SET device_id = $3 WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [tenant.tenantId, orderUuid, sequence.device_id],
    );
    await client.query(
      `UPDATE orders
          SET subtotal_idr = 0, discount_idr = 0, service_charge_idr = 0,
              tax_idr = 0, rounding_idr = 0, total_idr = 0, status = 'completed',
              business_date = business_date - $3::int
        WHERE tenant_id = $1 AND id = $2::uuid`,
      [tenant.tenantId, orderUuid, daysBefore],
    );
    await client.query(
      `INSERT INTO pos_receipts
         (tenant_id, outlet_id, order_id, sequence_id, device_id, number, sequence_number, status, issued_at, outlet_snapshot)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, 'issued', now(), $8::jsonb)`,
      [
        tenant.tenantId,
        outletId,
        orderUuid,
        sequence.id,
        sequence.device_id,
        formatReceiptNumber(prefix, ordinal),
        ordinal,
        SEED_SNAPSHOT,
      ],
    );
  });
}

function tenantScopeContext() {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

const pgDialect = new PgDialect();
const touchesReceipts = (text: string) => /\bpos_receipts\b/.test(text);

/**
 * Wraps a transaction so that `onRead` runs once, right after the first
 * statement touching pos_receipts has resolved (before its rows go back to the
 * caller). Covers query builders (`select`, `selectDistinct`, any chain, also
 * set operators) and raw `execute(sql...)`.
 */
function afterFirstReceiptRead(tx: object, onRead: () => Promise<void>) {
  let fired = false;
  const fire = async () => {
    if (fired) return;
    fired = true;
    await onRead();
  };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const watch = (builder: any): any => {
    const proxy: any = new Proxy(builder, {
      get(target, prop) {
        if (prop === "then")
          return (onFulfilled: any, onRejected: any) =>
            Promise.resolve(
              target.then(async (rows: unknown) => {
                let text = "";
                try {
                  text = target.toSQL().sql;
                } catch {
                  // not a builder with SQL: nothing to inspect
                }
                if (touchesReceipts(text)) await fire();
                return rows;
              }),
            ).then(onFulfilled, onRejected);
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          if (result === target) return proxy;
          if (result && typeof result === "object" && "toSQL" in result)
            return watch(result);
          return result;
        };
      },
    });
    return proxy;
  };
  const target = tx as any;
  return new Proxy(target, {
    get(_, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop === "select" || prop === "selectDistinct")
        return (...args: unknown[]) => watch(value.apply(target, args));
      if (prop === "execute")
        return async (query: any, ...rest: unknown[]) => {
          const result = await value.call(target, query, ...rest);
          let text = "";
          try {
            text = pgDialect.sqlToQuery(query).sql;
          } catch {
            // not a drizzle sql object
          }
          if (touchesReceipts(text)) await fire();
          return result;
        };
      return value.bind(target);
    },
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Runs `run` with edge mode on and always restores the previous state. */
async function inEdgeMode<T>(run: () => Promise<T>): Promise<T> {
  const previous = getEdgeRuntimeState();
  setEdgeRuntimeStateForTests({ ...previous, edgeMode: true });
  try {
    return await run();
  } finally {
    setEdgeRuntimeStateForTests(previous);
  }
}

type ShiftGap = { prefix: string; missing: number[]; writtenOff?: string[] };

describe("audited write-off of a lost receipt number (legend-0hzqw)", () => {
  it("only the owner role template holds pos.receipt.writeoff", () => {
    const holders = ROLE_TEMPLATES.filter((template) =>
      template.permissions.includes("pos.receipt.writeoff"),
    ).map((template) => template.key);
    expect(holders).toEqual(["owner"]);
  });

  it("repro: the owner writes off the hole, Tutup Hari then closes, and the write-off is audited and reported", async () => {
    const { outletId, closingDate, idle } = await outletWithHole("WA");

    const refused = await closeDay(outletId, closingDate);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCode(refused.body)).toBe("RECEIPT_SEQUENCE_GAP");
    expect(errorMessage(refused.body)).toBe(
      holeMessage(formatReceiptNumber("WA", 2)),
    );

    const created = await writeOff(ownerA, outletId, {
      prefix: "WA",
      sequenceNumber: 2,
      reason: REASON,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      outletId,
      prefix: "WA",
      sequenceNumber: 2,
      number: formatReceiptNumber("WA", 2),
      reason: REASON,
      writtenOffBy: ownerA.userId,
    });
    const writeoffId = created.body.data.id as string;

    const closed = await closeDay(outletId, closingDate);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await dailyCloseCount(outletId)).toBe(1);

    const { rows: audit } = await owner.query<{
      actor_id: string | null;
      reason: string | null;
      after: unknown;
    }>(
      `SELECT event->>'actorId' AS actor_id, event->>'reason' AS reason,
              event->'maskedChanges'->'after' AS after
         FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'pos.receipt.written_off'
          AND event->>'objectId' = $2`,
      [tenant.tenantId, writeoffId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_id).toBe(ownerA.userId);
    expect(audit[0]!.reason).toBe(REASON);
    expect(audit[0]!.after).toMatchObject({
      outletId,
      prefix: "WA",
      sequenceNumber: 2,
      number: formatReceiptNumber("WA", 2),
    });

    expect(await shiftReportGaps(outletId, idle.deviceId, closingDate)).toEqual(
      [
        {
          prefix: "WA",
          missing: [],
          lostRange: null,
          writtenOff: [formatReceiptNumber("WA", 2)],
        },
      ],
    );
  });

  it("a manager with pos.day.close but without pos.receipt.writeoff is refused (403) and nothing is written", async () => {
    const { outletId, closingDate } = await outletWithHole("WB");
    const refused = await writeOff(manager, outletId, {
      prefix: "WB",
      sequenceNumber: 2,
      reason: REASON,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(await writeoffRows(outletId)).toEqual([]);
    const stillBlocked = await closeDay(outletId, closingDate);
    expect(stillBlocked.status).toBe(409);
    expect(errorCode(stillBlocked.body)).toBe("RECEIPT_SEQUENCE_GAP");
  });

  it("a number that already has a receipt cannot be written off (409)", async () => {
    const { outletId } = await outletWithHole("WC");
    const refused = await writeOff(ownerA, outletId, {
      prefix: "WC",
      sequenceNumber: 3,
      reason: REASON,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(await writeoffRows(outletId)).toEqual([]);
  });

  it("an ordinal above the last issued number cannot be written off (409)", async () => {
    const { outletId } = await outletWithHole("WD");
    const refused = await writeOff(ownerA, outletId, {
      prefix: "WD",
      sequenceNumber: 4,
      reason: REASON,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(await writeoffRows(outletId)).toEqual([]);
  });

  it("writing off the same number twice: the second call is refused (409) and one row remains", async () => {
    const { outletId } = await outletWithHole("WE");
    const body = { prefix: "WE", sequenceNumber: 2, reason: REASON };
    const first = await writeOff(ownerA, outletId, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await writeOff(ownerA, outletId, body);
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(await writeoffRows(outletId)).toHaveLength(1);
  });

  it("the owner of another tenant cannot write off tenant A's number nor list its write-offs", async () => {
    const { outletId } = await outletWithHole("WF");
    const own = await writeOff(ownerA, outletId, {
      prefix: "WF",
      sequenceNumber: 2,
      reason: REASON,
    });
    expect(own.status, JSON.stringify(own.body)).toBe(201);

    // Tenant B's host and tenant A's host: either way the outlet is out of reach.
    for (const host of [otherHeaders, headers]) {
      const attempt = await writeOff(
        ownerB,
        outletId,
        { prefix: "WF", sequenceNumber: 1, reason: REASON },
        host,
      );
      expect([403, 404], JSON.stringify(attempt.body)).toContain(
        attempt.status,
      );
      const listing = await listWriteOffs(ownerB, outletId, host);
      expect([403, 404], JSON.stringify(listing.body)).toContain(
        listing.status,
      );
    }
    expect(await writeoffRows(outletId)).toHaveLength(1);

    // B's own outlet lists nothing of A.
    const ownList = await listWriteOffs(
      ownerB,
      otherTenant.outletId,
      otherHeaders,
    );
    expect(ownList.status, JSON.stringify(ownList.body)).toBe(200);
    expect(ownList.body.data).toEqual([]);
  });

  it("an unknown prefix answers 404", async () => {
    const { outletId } = await outletWithHole("WG");
    const refused = await writeOff(ownerA, outletId, {
      prefix: "NOPE",
      sequenceNumber: 2,
      reason: REASON,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(404);
    expect(await writeoffRows(outletId)).toEqual([]);
  });

  it("a reason shorter than 10 characters answers 422", async () => {
    const { outletId } = await outletWithHole("WH");
    const refused = await writeOff(ownerA, outletId, {
      prefix: "WH",
      sequenceNumber: 2,
      reason: "hilang",
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(await writeoffRows(outletId)).toEqual([]);
  });

  it("the table is append-only: even the database owner cannot UPDATE or DELETE a row (23514)", async () => {
    const { outletId } = await outletWithHole("WI");
    const created = await writeOff(ownerA, outletId, {
      prefix: "WI",
      sequenceNumber: 2,
      reason: REASON,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          `UPDATE receipt_number_writeoffs SET reason = 'diubah diam-diam'
            WHERE tenant_id = $1 AND outlet_id = $2`,
          [tenant.tenantId, outletId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          `DELETE FROM receipt_number_writeoffs WHERE tenant_id = $1 AND outlet_id = $2`,
          [tenant.tenantId, outletId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await writeoffRows(outletId)).toEqual([
      expect.objectContaining({ prefix: "WI", reason: REASON }),
    ]);
  });

  it("the database itself refuses a write-off of a number that has a receipt or lies past last_number (23514)", async () => {
    const { outletId } = await outletWithHole("WJ");
    const sequenceId = await sequenceIdOf(outletId, "WJ");
    for (const ordinal of [3, 4]) {
      await expect(
        asOwnerTenant(tenant.tenantId, (client) =>
          client.query(
            `INSERT INTO receipt_number_writeoffs
               (id, tenant_id, outlet_id, sequence_id, prefix, sequence_number, reason, written_off_by)
             VALUES ($1, $2, $3, $4, 'WJ', $5, $6, $7)`,
            [
              randomUUID(),
              tenant.tenantId,
              outletId,
              sequenceId,
              ordinal,
              REASON,
              ownerA.userId,
            ],
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
    expect(await writeoffRows(outletId)).toEqual([]);
  });

  it("GET lists the outlet's write-offs, newest first", async () => {
    const outletId = await freshOutlet();
    await seedActiveDevice(outletId);
    await seedDevice(
      outletId,
      [{ prefix: "WK", lastNumber: 5, present: [1, 3, 5], ageMinutes: 30 }],
      { daysBefore: 1 },
    );

    const empty = await listWriteOffs(ownerA, outletId);
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect(empty.body.data).toEqual([]);

    for (const sequenceNumber of [2, 4]) {
      const created = await writeOff(ownerA, outletId, {
        prefix: "WK",
        sequenceNumber,
        reason: REASON,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
    }
    const listed = await listWriteOffs(ownerA, outletId);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(
      (listed.body.data as { number: string }[]).map((row) => row.number),
    ).toEqual([formatReceiptNumber("WK", 4), formatReceiptNumber("WK", 2)]);
    expect(listed.body.data[0]).toMatchObject({
      outletId,
      prefix: "WK",
      reason: REASON,
      writtenOffBy: ownerA.userId,
    });

    // A manager without the permission cannot read the list either.
    const denied = await listWriteOffs(manager, outletId);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
  });

  it("an owner whose session has no verified second factor is refused on POST (403 MFA_REQUIRED) and nothing is written", async () => {
    const { outletId, closingDate } = await outletWithHole("WM1");
    const refused = await writeOff(ownerNoMfa, outletId, {
      prefix: "WM1",
      sequenceNumber: 2,
      reason: REASON,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(errorCode(refused.body)).toBe("MFA_REQUIRED");
    expect(await writeoffRows(outletId)).toEqual([]);

    // Reading the list does not need the second factor.
    const listed = await listWriteOffs(ownerNoMfa, outletId);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data).toEqual([]);

    const stillBlocked = await closeDay(outletId, closingDate);
    expect(stillBlocked.status).toBe(409);
    expect(errorCode(stillBlocked.body)).toBe("RECEIPT_SEQUENCE_GAP");
  });

  it("a receipt that arrives later for a written-off number leaves the writtenOff list, the day closes, and the audit row stays", async () => {
    const { outletId, closingDate, idle } = await outletWithHole("WL");
    const created = await writeOff(ownerA, outletId, {
      prefix: "WL",
      sequenceNumber: 2,
      reason: REASON,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    await insertLateReceipt(outletId, "WL", 2);

    // Close first: the shift report helper opens a shift, which blocks the close.
    const closed = await closeDay(outletId, closingDate);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await dailyCloseCount(outletId)).toBe(1);

    const gaps = (await shiftReportGaps(
      outletId,
      idle.deviceId,
      closingDate,
    )) as ShiftGap[];
    const entry = gaps.find((gap) => gap.prefix === "WL");
    // No entry at all is as good as an entry that lists nothing.
    if (entry) {
      expect(entry.missing).toEqual([]);
      expect(entry.writtenOff ?? []).toEqual([]);
    }

    // The audit evidence is never removed.
    expect(await writeoffRows(outletId)).toHaveLength(1);
  });

  it("a late receipt does not hide a real gap: receipt 1, write-off 2, late receipt 2 still reports 3 as missing", async () => {
    const outletId = await freshOutlet();
    await seedActiveDevice(outletId);
    await seedDevice(
      outletId,
      [
        {
          prefix: "WN1",
          lastNumber: 3,
          present: [1],
          ageMinutes: 60,
          retired: { reason: "claim_rotated", edgeReportedNumber: 0 },
        },
      ],
      { daysBefore: 1 },
    );
    const created = await writeOff(ownerA, outletId, {
      prefix: "WN1",
      sequenceNumber: 2,
      reason: REASON,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // Written off 2 + receipt 1 = 2 of 3: number 3 is still missing.
    expect(await outletGaps(outletId)).toEqual([
      expect.objectContaining({ prefix: "WN1", missing: [3] }),
    ]);

    await insertLateReceipt(outletId, "WN1", 2);
    // Receipts 1 and 2, write-off no longer counts: 3 must still be missing,
    // not hidden because 2 receipts + 1 write-off add up to 3.
    expect(await outletGaps(outletId)).toEqual([
      expect.objectContaining({ prefix: "WN1", missing: [3] }),
    ]);
  });

  it("fast path mix: one clean run and one run whose only hole is written off report no gaps", async () => {
    const { outletId } = await outletWithHole("WO1");
    expect(await outletGaps(outletId)).toEqual([
      expect.objectContaining({ prefix: "WO1", missing: [2] }),
    ]);
    const created = await writeOff(ownerA, outletId, {
      prefix: "WO1",
      sequenceNumber: 2,
      reason: REASON,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await outletGaps(outletId)).toEqual([]);
  });

  it("a user holding the permission only through an outlet-scoped assignment on outlet X is refused on outlet Y (403/404)", async () => {
    const outletX = await outletWithHole("WP1");
    const outletY = await outletWithHole("WQ1");
    const scoped = await member(
      ids.ownerRole,
      "Pemilik Outlet X",
      tenant.tenantId,
      { mfa: true, outletId: outletX.outletId },
    );

    const refused = await writeOff(scoped, outletY.outletId, {
      prefix: "WQ1",
      sequenceNumber: 2,
      reason: REASON,
    });
    expect([403, 404], JSON.stringify(refused.body)).toContain(refused.status);
    expect(await writeoffRows(outletY.outletId)).toEqual([]);
    const listing = await listWriteOffs(scoped, outletY.outletId);
    expect([403, 404], JSON.stringify(listing.body)).toContain(listing.status);

    // Control: the same user may write off on outlet X.
    const allowed = await writeOff(scoped, outletX.outletId, {
      prefix: "WP1",
      sequenceNumber: 2,
      reason: REASON,
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    expect(await writeoffRows(outletX.outletId)).toHaveLength(1);
  });

  it("with the edge state on, a write-off is refused (409) and nothing is written; in the cloud it works", async () => {
    const { outletId } = await outletWithHole("WR1");
    const body = { prefix: "WR1", sequenceNumber: 2, reason: REASON };
    const refused = await inEdgeMode(() => writeOff(ownerA, outletId, body));
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(await writeoffRows(outletId)).toEqual([]);

    // The state is restored: the same request now succeeds.
    const created = await writeOff(ownerA, outletId, body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  });

  // ---- legend-l56xd: owner template only, recent re-auth -----------------------

  it("repro l56xd: a custom role that holds pos.receipt.writeoff is refused on POST and GET (403) and nothing is written; the owner still works", async () => {
    const { outletId } = await outletWithHole("WS1");
    // The session is MFA-verified just now, so only the role can be the reason.
    const delegate = await member(
      ids.customWriteoffRole,
      "Pemilik Kustom",
      tenant.tenantId,
      { mfa: true },
    );
    const body = { prefix: "WS1", sequenceNumber: 2, reason: REASON };

    const refused = await writeOff(delegate, outletId, body);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(errorCode(refused.body)).toBe("PERMISSION_DENIED");
    expect(await writeoffRows(outletId)).toEqual([]);

    const listing = await listWriteOffs(delegate, outletId);
    expect(listing.status, JSON.stringify(listing.body)).toBe(403);

    const created = await writeOff(ownerA, outletId, body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await writeoffRows(outletId)).toHaveLength(1);
  });

  it("a stale second factor (verified 10 minutes ago) is refused on POST (401 REAUTH_REQUIRED) and writes nothing; GET still works; verifying again unlocks POST", async () => {
    const { outletId } = await outletWithHole("WS2");
    const stale = await member(ids.ownerRole, "Pemilik Basi", tenant.tenantId, {
      mfa: true,
    });
    await owner.query(
      `UPDATE "session" SET mfa_verified_at = $2
        WHERE revoked_at IS NULL AND user_id = $1`,
      [stale.userId, new Date(Date.now() - 10 * 60_000)],
    );
    const body = { prefix: "WS2", sequenceNumber: 2, reason: REASON };

    const refused = await writeOff(stale, outletId, body);
    expect(refused.status, JSON.stringify(refused.body)).toBe(401);
    expect(errorCode(refused.body)).toBe("REAUTH_REQUIRED");
    expect(await writeoffRows(outletId)).toEqual([]);

    const listed = await listWriteOffs(stale, outletId);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data).toEqual([]);

    // Verifying the second factor again (stamp now) lets the same call through.
    await owner.query(
      `UPDATE "session" SET mfa_verified_at = $2
        WHERE revoked_at IS NULL AND user_id = $1`,
      [stale.userId, new Date()],
    );
    const created = await writeOff(stale, outletId, body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await writeoffRows(outletId)).toHaveLength(1);
  });

  // ---- legend-xlvvl ---------------------------------------------------------------

  it("repro xlvvl b: with the edge state on, listing the write-offs is refused (409); in the cloud it works", async () => {
    const outletId = await freshOutlet();
    const refused = await inEdgeMode(() => listWriteOffs(ownerA, outletId));
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);

    const listed = await listWriteOffs(ownerA, outletId);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data).toEqual([]);
  });

  it("repro xlvvl c: a receipt that commits between the slow helper's reads does not make a false gap", async () => {
    // Run lastNumber 3, receipts 1 and 3, number 2 written off. Receipt 2 then
    // arrives late and commits right after the helper read the receipts. The
    // helper must still report no gap: with two statements it saw receipts
    // {1,3} and then a write-off list that already dropped 2 (it has a
    // receipt now), so it invented a gap at 2; one statement is one snapshot.
    const outletId = await freshOutlet();
    await seedDevice(
      outletId,
      [
        {
          prefix: "WS3",
          lastNumber: 3,
          present: [1, 3],
          ageMinutes: 60,
          retired: { reason: "claim_rotated", edgeReportedNumber: 0 },
        },
      ],
      { daysBefore: 1 },
    );
    const created = await writeOff(ownerA, outletId, {
      prefix: "WS3",
      sequenceNumber: 2,
      reason: REASON,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    // Assumption: the interleave is made deterministic by wrapping the
    // transaction handed to the helper. The first statement that touches
    // pos_receipts (a select builder or a raw execute) resolves, then the late
    // receipt is committed on a separate owner connection, then the helper goes
    // on. This holds for the one-statement fix too (the late receipt then
    // commits after the only read).
    let lateCommitted = false;
    const context = tenantScopeContext();
    const gaps = await withTenant(db, context, (tx) =>
      receiptGapsForOutlet(
        afterFirstReceiptRead(tx, async () => {
          await insertLateReceipt(outletId, "WS3", 2);
          lateCommitted = true;
        }) as never,
        context,
        outletId,
      ),
    );
    expect(lateCommitted, "the late receipt was committed mid-helper").toBe(
      true,
    );
    expect(gaps).toEqual([]);
    // After everything committed there is still no gap.
    expect(await outletGaps(outletId)).toEqual([]);
  });
});
