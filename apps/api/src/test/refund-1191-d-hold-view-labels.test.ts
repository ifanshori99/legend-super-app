// legend-sy98y (brief 1191, card 4, money display): the "Refund tertahan" list
// must tell finance WHICH payment and WHICH outlet a hold belongs to:
// `paymentReference` (the bill reference of the payment) and `outletName`.
// Written from docs/briefs/1025c-celah-refund-lanjutan.md (legend-sy98y), the
// shared view schema (packages/shared/src/payment/admin.ts) and the 1025-d
// fixtures, NOT from the service code. No other test asserts paymentReference.
//
// Endpoint (mount /api/payments/admin, permission payment.reconcile):
//   GET /refund-recon-holds?status=open|resolved   -> { data: RefundReconHoldView[] }
//
// Assumptions (the brief does not fix them):
//  - `paymentReference` is the reference of the payment's bill (payment_links.reference),
//    the same label the unallocated-funds list shows ("seperti unallocated-panel").
//  - `outletName` is the name of the outlet of the held payment, `outletId` its id.
//  - Holds are seeded straight into refund_recon_holds (the webhook pipeline that
//    files them is covered elsewhere).
//  - A user without payment.reconcile (cashier) gets 403 and sees nothing.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1191-d-hold-view-labels.test.ts" heavy pnpm test

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { refundReconHoldViewSchema } from "@starter/shared/payment/admin";
import { createApp } from "../app";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { paymentTestScope } from "./payment-test-scope";

vi.setConfig({ testTimeout: 120_000 });

const scope = paymentTestScope();
const otherScope = paymentTestScope();
const app = createApp();
const ADMIN = "/api/payments/admin";
const BILL = 100_000;
const NAME_MAIN = "Outlet Kemang 1191";
const NAME_SECOND = "Outlet Senopati 1191";
const NAME_OTHER_TENANT = "Outlet Rahasia Tenant Lain 1191";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

type Client = ReturnType<typeof agent>;
let staff: Client; // owner: payment.reconcile
let cashier: Client; // no payment.reconcile
const userIds: string[] = [];
const linkIds: string[] = [];
const otherLinkIds: string[] = [];

async function roleIdOf(tenantId: string, templateKey: string) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function assign(
  userId: string,
  templateKey: string,
  scopeType: "tenant" | "outlet",
) {
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      scope.tenantId,
      userId,
      await roleIdOf(scope.tenantId, templateKey),
      scopeType,
      scopeType === "outlet" ? scope.outletId : null,
    ],
  );
}

async function signedIn(label: string) {
  const client = agent(app).set("Host", scope.hostname);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const id = session.body.user.id as string;
  userIds.push(id);
  await verifySessionMfa(email);
  return { client, id };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await scope.seed(owner);
  await otherScope.seed(owner);
  // Distinct, recognizable outlet names (rows owned by these suite-only tenants).
  for (const [id, name] of [
    [scope.outletId, NAME_MAIN],
    [scope.otherOutletId, NAME_SECOND],
    [otherScope.outletId, NAME_OTHER_TENANT],
  ] as const)
    await owner.query("UPDATE outlets SET name = $2 WHERE id = $1", [id, name]);

  const first = await signedIn("Hold1191d owner");
  staff = first.client;
  await assign(first.id, "owner", "tenant");
  const till = await signedIn("Hold1191d cashier");
  cashier = till.client;
  await assign(till.id, "cashier", "outlet");
});

afterAll(async () => {
  for (const [tenant, links] of [
    [scope.tenantId, linkIds],
    [otherScope.tenantId, otherLinkIds],
  ] as const) {
    if (links.length === 0) continue;
    const intents =
      "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
    for (const table of ["refund_recon_holds", "payment_evidence"])
      await owner.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
        [tenant, links],
      );
    await owner.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [tenant, links],
    );
    await owner.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant, links],
    );
  }
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [scope.tenantId, userIds],
  );
  await owner.end();
});

type Intent = { id: string; reference: string; outletId: string };

/** A settled 100.000 bill with its own bill reference at `outletId`. */
async function seedIntent(
  s: typeof scope,
  links: string[],
  outletId: string,
  reference: string,
): Promise<Intent> {
  const linkId = randomUUID();
  const id = randomUUID();
  const providerRef = `dp_1191d_${randomBytes(8).toString("hex")}`;
  links.push(linkId);
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'refund-1191d-test')`,
    [
      linkId,
      s.tenantId,
      outletId,
      randomBytes(32).toString("hex"),
      reference,
      BILL,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at, provider_ref)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now() + interval '1 hour', $7)`,
    [id, s.tenantId, outletId, linkId, BILL, `h1191d-${id}`, providerRef],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [s.tenantId, outletId, id, providerRef, BILL],
  );
  return { id, reference, outletId };
}

async function seedHold(
  s: typeof scope,
  intent: Intent,
  refundId: string | null = `rf_${randomBytes(6).toString("hex")}`,
): Promise<string> {
  const holdId = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [s.tenantId],
    );
    await client.query(
      `INSERT INTO refund_recon_holds
         (id, tenant_id, payment_intent_id, webhook_event_id, provider_refund_id, amount_idr, provider_refund_id_kind, reason)
       VALUES ($1, $2, $3, $4, $5, 30000, $6, 'Reference names another intent')`,
      [
        holdId,
        s.tenantId,
        intent.id,
        randomUUID(),
        refundId,
        refundId === null ? null : "provider",
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return holdId;
}

const listHolds = (client: Client, query = "") =>
  client.get(`${ADMIN}/refund-recon-holds${query}`);

type View = ReturnType<typeof refundReconHoldViewSchema.parse>;
const viewOf = (response: { body: { data: View[] } }, holdId: string) =>
  response.body.data.find((row) => row.id === holdId);

describe("1191-d: the refund-hold list names the payment and the outlet", () => {
  it("1191-d-01 an open hold shows the bill reference of its payment and the name of its outlet", async () => {
    const reference = `BILL-1191D-${randomBytes(3).toString("hex")}`;
    const intent = await seedIntent(scope, linkIds, scope.outletId, reference);
    const holdId = await seedHold(scope, intent);

    const response = await listHolds(staff);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const row = viewOf(response, holdId);
    expect(row, "the open hold is listed").toBeDefined();
    expect(refundReconHoldViewSchema.safeParse(row).success).toBe(true);
    expect(row).toMatchObject({
      paymentIntentId: intent.id,
      paymentReference: reference,
      outletId: scope.outletId,
      outletName: NAME_MAIN,
    });
  });

  it("1191-d-02 holds of two outlets of the same tenant each show their own outlet name and bill reference", async () => {
    const refA = `BILL-1191D-A-${randomBytes(3).toString("hex")}`;
    const refB = `BILL-1191D-B-${randomBytes(3).toString("hex")}`;
    const a = await seedIntent(scope, linkIds, scope.outletId, refA);
    const b = await seedIntent(scope, linkIds, scope.otherOutletId, refB);
    const holdA = await seedHold(scope, a);
    const holdB = await seedHold(scope, b);

    const response = await listHolds(staff);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(viewOf(response, holdA)).toMatchObject({
      paymentReference: refA,
      outletName: NAME_MAIN,
    });
    expect(viewOf(response, holdB)).toMatchObject({
      paymentReference: refB,
      outletName: NAME_SECOND,
    });
  });

  it("1191-d-03 a hold without a provider refund id still shows its payment reference and outlet name", async () => {
    const reference = `BILL-1191D-N-${randomBytes(3).toString("hex")}`;
    const intent = await seedIntent(scope, linkIds, scope.outletId, reference);
    const holdId = await seedHold(scope, intent, null);

    const response = await listHolds(staff);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(viewOf(response, holdId)).toMatchObject({
      providerRefundId: null,
      paymentReference: reference,
      outletName: NAME_MAIN,
    });
  });

  it("1191-d-04 a resolved hold keeps its labels in the resolved list", async () => {
    const reference = `BILL-1191D-R-${randomBytes(3).toString("hex")}`;
    const intent = await seedIntent(scope, linkIds, scope.outletId, reference);
    const holdId = await seedHold(scope, intent);

    const resolved = await staff
      .post(`${ADMIN}/refund-recon-holds/${holdId}/resolve`)
      .set(originHeader)
      .send({
        idempotencyKey: `hold-${randomUUID()}`,
        resolution: "not_this_intent",
        note: "Dicocokkan dengan mutasi bank provider",
      });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body.data).toMatchObject({
      paymentReference: reference,
      outletName: NAME_MAIN,
    });

    const open = await listHolds(staff, "?status=open");
    expect(viewOf(open, holdId), "no longer in the open list").toBeUndefined();
    const closed = await listHolds(staff, "?status=resolved");
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(viewOf(closed, holdId)).toMatchObject({
      paymentReference: reference,
      outletName: NAME_MAIN,
    });
  });

  it("1191-d-05 another tenant's holds, bill references and outlet names never appear", async () => {
    const secret = `BILL-1191D-SECRET-${randomBytes(3).toString("hex")}`;
    const foreign = await seedIntent(
      otherScope,
      otherLinkIds,
      otherScope.outletId,
      secret,
    );
    const foreignHold = await seedHold(otherScope, foreign);
    const mine = await seedIntent(
      scope,
      linkIds,
      scope.outletId,
      `BILL-1191D-M-${randomBytes(3).toString("hex")}`,
    );
    const myHold = await seedHold(scope, mine);

    for (const status of ["open", "resolved"]) {
      const response = await listHolds(staff, `?status=${status}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(foreignHold);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(NAME_OTHER_TENANT);
    }
    const open = await listHolds(staff);
    expect(viewOf(open, myHold), "own hold is listed").toBeDefined();
  });

  it("1191-d-06 a user without the reconcile permission is refused and sees no labels", async () => {
    const intent = await seedIntent(
      scope,
      linkIds,
      scope.outletId,
      `BILL-1191D-P-${randomBytes(3).toString("hex")}`,
    );
    await seedHold(scope, intent);
    const response = await listHolds(cashier);
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain(intent.reference);
    expect(JSON.stringify(response.body)).not.toContain(NAME_MAIN);
  });
});
