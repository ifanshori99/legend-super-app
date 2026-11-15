// Fail-first regression test for legend-eqeu7 (POLL SPLIT, docs/briefs/so-879-qris-hold-fix.md).
//
// Bug: `createGuestPayment` ran `getIntentView` (provider status call + the
// settlement of a paid answer, `applyConfirmation`) INSIDE the transaction that
// holds the order row lock. The settlement opens its own transaction and waits
// for that same order lock, so the request waits on itself: a lost-webhook
// QRIS that the provider already marks paid hangs the guest's second tap.
//
// Correct outcome: provider I/O and settlement run outside the order lock; the
// intent is read again under the lock. The second tap answers the paid intent,
// the intent is settled exactly once (one `payment.paid` event).
//
// Assumptions:
// - "Lost webhook" = the gateway double answers `paid` with the exact amount
//   to the status call; nobody calls `confirmPayment`.
// - A request that does not answer within WAIT_MS is judged hung. The hung
//   backends are terminated afterwards so the test process can exit.
import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import type { PaymentInstructions } from "@starter/shared/payment";
import { createApp } from "../app.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

vi.setConfig({ testTimeout: 60_000 });

const WAIT_MS = 15_000;
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

/** QRIS gateway double; `paidRefs` maps a provider ref to the amount it paid. */
class ScriptedGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  readonly paidRefs = new Map<string, number>();
  created = 0;
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created += 1;
    const instructions: PaymentInstructions = {
      method: "qris",
      qrPayload: "00020101021226FAKEQRSO879B",
      issuer: null,
    };
    return {
      providerRef: `QSB-${randomBytes(6).toString("hex")}-${this.created}`,
      instructions,
      expiresAt: input.expiresAt,
    };
  }
  async getStatus(input: { providerRef: string }) {
    const paid = this.paidRefs.get(input.providerRef);
    if (paid === undefined)
      return {
        status: "pending" as const,
        providerRef: input.providerRef,
        amountIdr: null,
      };
    return {
      status: "paid" as const,
      providerRef: input.providerRef,
      amountIdr: paid,
      paidAt: new Date().toISOString(),
    };
  }
  async channels() {
    return [];
  }
}
const gateway = new ScriptedGateway();

let app: Express;
let tenant: IsolatedTenant;
let staff: Staff;
let headers: { Host: string };
const createdTenantIds: string[] = [];
const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
};

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client as unknown as Client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setPaymentGateway(gateway);
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  setAuditWriter(coreAuditWriter);
  tenant = await createIsolatedTenant(`so879b-${randomUUID().slice(0, 6)}`);
  createdTenantIds.push(tenant.tenantId);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'SO879 B Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, 25000)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, staff.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-SB', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, staff.userId],
    );
  });
});

afterAll(async () => {
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
  setAuditWriter(null);
  for (const tenantId of createdTenantIds)
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

describe("legend-eqeu7 poll split: provider I/O and settlement outside the order lock", () => {
  it("SO879-B-01 a lost-webhook QRIS the provider marks paid is settled once by the guest's second tap, which does not wait on its own order lock", async () => {
    const zone = await createZone(
      staff.client,
      { paymentMode: "pay_first", serviceChargeBp: 0, hours: ALL_DAY },
      headers,
    );
    const table = await createTable(staff.client, { zoneId: zone.id }, headers);
    const qr = await issueQr(staff.client, table.id, headers);
    const scanned = await scan(app, {
      token: qr.token,
      hostname: tenant.hostname,
    });
    expect(scanned.status).toBe(201);
    const sessionId = scanned.body.data.session.id as string;
    const client = agent(app);
    const auth = (test: ReturnType<typeof client.get>) =>
      test
        .set("Host", tenant.hostname)
        .set("Authorization", `Bearer ${scanned.body.data.sessionToken}`)
        .set(originHeader);
    const base = `/api/table-sessions/${sessionId}`;
    const added = await auth(client.post(`${base}/cart/lines`)).send({
      idempotencyKey: randomUUID(),
      modifierIds: [],
      menuItemId: ids.kopi,
      quantity: 1,
      expectedCartVersion: 0,
    });
    expect(added.status).toBe(201);
    const placed = await auth(client.post(`${base}/orders`)).send({
      expectedCartVersion: added.body.data.cart.version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    const orderId = placed.body.data.order.id as string;
    const totalIdr = placed.body.data.order.totalIdr as number;
    const pay = () =>
      auth(client.post(`${base}/payments`)).send({
        target: { kind: "order", orderId },
        method: "qris",
        idempotencyKey: randomUUID(),
      });

    const first = await pay();
    expect(first.status).toBe(201);
    expect(first.body.data.status).toBe("pending");
    const intentId = first.body.data.id as string;

    // The webhook is lost; the provider now says the exact amount was paid.
    const { rows } = await owner.query<{ provider_ref: string }>(
      "SELECT provider_ref FROM payment_intents WHERE tenant_id = $1 AND id = $2",
      [tenant.tenantId, intentId],
    );
    gateway.paidRefs.set(rows[0]!.provider_ref, totalIdr);

    let timer: NodeJS.Timeout | undefined;
    const hung = Symbol("hung");
    const second = await Promise.race([
      pay().then((res) => res),
      new Promise<typeof hung>((resolve) => {
        timer = setTimeout(() => resolve(hung), WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (second === hung) {
      // Free the self-wait so the process can finish, then fail.
      await owner.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND pid <> pg_backend_pid()`,
      );
      expect.fail("second tap waited on its own order lock");
    }
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.data.status).toBe("paid");
    expect(second.body.data.id).toBe(intentId);

    // Settled exactly once, whatever the poll order.
    const events = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
          AND event->'payload'->>'intentId' = $2`,
      [tenant.tenantId, intentId],
    );
    expect(Number(events.rows[0]!.n)).toBe(1);
    const third = await pay();
    expect(third.body.data.status).toBe("paid");
    const again = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
          AND event->'payload'->>'intentId' = $2`,
      [tenant.tenantId, intentId],
    );
    expect(Number(again.rows[0]!.n)).toBe(1);
  });
});
