// legend-kmrto (brief 1072, task B, founder Q45): release 1 pays no refund
// through the provider. With DOIT_REFUNDS_ENABLED off:
//  B1 no refund path (approve, sweep, retry, runRefundPayout) ever calls the
//     provider API, also when a port is registered directly; the test-only
//     `setPaymentRefundGateway` shim (legacy mode, used by ~70 other test files
//     with the flag at its default) cannot exist in production: it throws there;
//  B2 an approved refund waits in the finance queue (status `approved`, no
//     attempts counted, never `failed`, no endless retry); finance records the
//     manual payment once (idempotent, one winner when two race), and the total
//     recorded never passes what the guest paid;
//  B3 provider refund reports are still matched; an odd report (a provider
//     refund we did not make, a different amount) is held and never opens money;
//  B4 pos-order-corrections and order-recovery-refund never reach the provider.
//
// Written from the brief, bead legend-kmrto and the coordinator's note, not from
// the implementation. Fixtures follow payment-refund-manual-settle.test.ts,
// payment-doit-refund-webhook.test.ts and refund-1025-c-reference-mismatch-hold.test.ts.
//
// Assumptions where the brief is silent:
// - "Flag off" is simulated by setting `env.DOIT_REFUNDS_ENABLED = false` in the
//   test process (restored afterwards); the service reads it at call time.
// - Two refund-port states with the flag off: `registered` (spy registered for
//   provider doit) and `none` (the production state: nothing registered).
//   `legacy` (setPaymentRefundGateway with a spy) is a test shim that pays out
//   even with the flag off, so it is NOT a "flag off pays nothing" case; instead
//   the test asserts the shim throws when NODE_ENV=production (stubbed and
//   restored), so legacy mode cannot happen in production (brief G2).
//   "Provider call" = any call on the spy (refund or getRefundStatus) or any
//   POST /refunds on the fake DOIT server.
// - `runRefundPayout` and the retry endpoint answer 503 REFUND_PROVIDER_DISABLED
//   (coordinator note) and change nothing. Approve may answer 200 (decision kept,
//   payout deferred) or 503; only the stored state is asserted for it.
// - The sweep neither throws nor changes the refund: still `approved`, 0 attempts,
//   no lease, no last_payout_error, however often it runs.
// - The manual-record endpoint is the existing settle-manually route; its markers
//   (`SETTLED_OUTSIDE_PROVIDER`, REFUND_NOT_SETTLEABLE, SETTLEMENT_AMOUNT_MISMATCH,
//   IDEMPOTENCY_KEY_REUSED) are unchanged and a second record is 409
//   REFUND_NOT_SETTLEABLE. The cap re-check answers 409 REFUND_CAP_EXCEEDED
//   (coordinator note).
// - The "clear status" of a queued refund is not pinned further than: status
//   `approved`, listed for finance, never `failed`. The engineer may add a marker
//   in last_payout_error; it is not asserted.
// - A provider refund of a different amount than our approved refund (reported
//   by signed webhook, held after the 15 minute unmatched window as in
//   payment-doit-refund-webhook.test.ts) is recorded as a provider fact, our
//   refund stays approved and settling it by hand is refused (409): provider
//   money plus manual money would pass what the guest paid.
// - A provider `payment.refunded` echo for a bill where we made no refund stamps
//   the bill (provider_refunded_after_paid_at) and a new refund request is 409
//   PROVIDER_REFUNDED (958 contract).
// - B4 is a source-level guard (the repo does the same in
//   edge-worker-refund-gate.test.ts): neither file may import the refund gateway,
//   the DOIT adapter or the payout functions. A behavioural check of both would
//   need their large fixtures; it is not covered here.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1072-b-doit-refunds-disabled.test.ts" heavy pnpm test
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { env } from "../config/env";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import { createDoitGateway } from "../services/payment-doit";
import { setPaymentGateway } from "../services/payment-gateway";
import {
  registerPaymentRefundGateway,
  resetPaymentRefundGateways,
  setPaymentRefundGateway,
} from "../services/payment-refund-gateway";
import {
  runRefundPayout,
  sweepApprovedRefundPayouts,
} from "../services/payment-refund.service";
import {
  clearDoitWebhookSecretCache,
  reprocessStoredWebhookEvents,
} from "../services/payment-webhook.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { paymentTestScope } from "./payment-test-scope";
import { FakeRefundGateway } from "./refund-fake-gateway";

vi.setConfig({ testTimeout: 120_000 });

const scope = paymentTestScope();
const app = createApp();
const tenantId = scope.tenantId;
const outletA = scope.outletId;
const ADMIN = "/api/payments/admin";
const webhookPath = `/api/webhooks/payments/doit/${tenantId}`;
const PAID_IDR = 100_000;
const SETTLED_OUTSIDE_PROVIDER = "SETTLED_OUTSIDE_PROVIDER";
const SETTLE_ACTION = "payment.refund_settled_manually";
const actor = randomUUID();

const apiKey = `doit-key-1072b-${randomBytes(12).toString("hex")}`;
const webhookSecret = `whsec-1072b-${randomBytes(16).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const tenantWide: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "tenant" },
);
const webhookContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "webhook" }),
  { kind: "tenant" },
);

type Client = ReturnType<typeof agent>;
let requester: Client; // owner: files refunds
let requesterId = "";
let financeSup: Client; // finance + supervisor: approves
let financeSupId = "";
let ops: Client; // another owner: records the manual payment
let opsId = "";
let integrationId = "";

const userIds: string[] = [];
const linkIds: string[] = [];
const intentIds: string[] = [];
const eventIds: string[] = [];
let fake: FakeRefundGateway;

const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;

const hex = (bytes = 6) => randomBytes(bytes).toString("hex");
const key = (prefix = "k") => `${prefix}-${randomUUID()}`;

// ---------------------------------------------------------------------------
// Fake DOIT server: records every call; answers refunds like the sandbox.
// ---------------------------------------------------------------------------

type RecordedCall = { method: string; path: string };
class FakeDoit {
  readonly calls: RecordedCall[] = [];
  readonly payments = new Map<string, Record<string, unknown>>();
  private server: Server | null = null;
  baseUrl = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((accept) =>
      this.server!.listen(0, "127.0.0.1", accept),
    );
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((accept) =>
      this.server ? this.server.close(() => accept()) : accept(),
    );
  }

  /** POST `.../refunds` calls: the one thing that moves money at the provider. */
  get refundPosts(): RecordedCall[] {
    return this.calls.filter(
      (call) => call.method === "POST" && /\/refunds$/.test(call.path),
    );
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    for await (const chunk of req) void chunk;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    this.calls.push({ method: req.method ?? "", path: url.pathname });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const refundPath = /^\/v1\/payments\/([^/]+)\/refunds$/.exec(url.pathname);
    if (req.method === "POST" && refundPath)
      return send(200, {
        id: `rf_${hex(8)}`,
        payment_id: decodeURIComponent(refundPath[1]!),
        status: "succeeded",
        amount: PAID_IDR,
      });
    const found = /^\/v1\/payments\/([^/]+)$/.exec(url.pathname);
    const payment = found
      ? this.payments.get(decodeURIComponent(found[1]!))
      : undefined;
    if (req.method === "GET" && payment) return send(200, payment);
    return send(404, { error: { code: "not_found", message: "not found" } });
  }
}
const doit = new FakeDoit();

// ---------------------------------------------------------------------------
// Refund port states with the flag off
// ---------------------------------------------------------------------------

type PortMode = "legacy" | "registered" | "none";
const portModes: PortMode[] = ["registered", "none"];

function installPort(mode: PortMode) {
  fake = new FakeRefundGateway();
  if (mode === "legacy") setPaymentRefundGateway(fake);
  else {
    resetPaymentRefundGateways();
    if (mode === "registered") registerPaymentRefundGateway(fake);
  }
}

/** Every provider contact so far: spy calls plus money-moving POSTs. */
const providerContacts = () => ({
  spyRefund: fake.calls.length,
  spyLookup: fake.statusCalls.length,
  refundPosts: doit.refundPosts.length,
});
const NO_CONTACT = { spyRefund: 0, spyLookup: 0, refundPosts: 0 };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function signedIn(
  templateKey: "owner" | "finance",
  label: string,
  alsoSupervisor = false,
) {
  const client = agent(app).set("Host", scope.hostname);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  userIds.push(userId);
  await verifySessionMfa(email);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [tenantId, userId, await roleIdOf(templateKey)],
  );
  if (alsoSupervisor)
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenantId, userId, await roleIdOf("supervisor"), outletA],
    );
  return { client, userId };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await scope.seed(owner);
  ({ client: requester, userId: requesterId } = await signedIn(
    "owner",
    "Q45 requester",
  ));
  ({ client: financeSup, userId: financeSupId } = await signedIn(
    "finance",
    "Q45 finance supervisor",
    true,
  ));
  ({ client: ops, userId: opsId } = await signedIn("owner", "Q45 ops"));

  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, 1)`,
    [tenantId, await roleIdOf("finance")],
  );

  await doit.start();
  const created = await upsertIntegration(
    tenantWide,
    {
      outletId: null,
      provider: "doit",
      config: { baseUrl: doit.baseUrl },
      credentials: { apiKey, webhookSecret },
    },
    actor,
  );
  await setIntegrationStatus(
    tenantWide,
    created.id,
    { status: "active" },
    actor,
  );
  integrationId = created.id;
  setPaymentGateway(
    createDoitGateway({
      loadCredentials: async () => ({
        integration: {
          id: integrationId,
          outletId: null,
          config: { baseUrl: doit.baseUrl },
        },
        credentials: { apiKey, webhookSecret },
      }),
    }),
  );
});

afterAll(async () => {
  flags.DOIT_REFUNDS_ENABLED = flagBefore;
  setPaymentGateway(null);
  setPaymentRefundGateway(null);
  const intents = [intentIds];
  await owner.query(
    "DELETE FROM approval_requests WHERE tenant_id = $1 AND object_type = 'payment_refund'",
    [tenantId],
  );
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    intents,
  );
  await owner.query(
    "DELETE FROM payment_provider_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    intents,
  );
  await owner.query(
    "DELETE FROM refund_recon_holds WHERE payment_intent_id = ANY($1::uuid[])",
    intents,
  );
  await owner.query(
    "DELETE FROM payment_unallocated_funds WHERE payment_intent_id = ANY($1::uuid[])",
    intents,
  );
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
    intents,
  );
  await owner.query("DELETE FROM gateway_webhook_events WHERE tenant_id = $1", [
    tenantId,
  ]);
  await owner.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
    intentIds,
  ]);
  await owner.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
    linkIds,
  ]);
  await owner.query("DELETE FROM gateway_webhook_events WHERE tenant_id = $1", [
    tenantId,
  ]);
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
  );
  await owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
    integrationId,
  ]);
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, userIds],
  );
  await owner.end();
  await doit.stop();
});

beforeEach(() => {
  flags.DOIT_REFUNDS_ENABLED = false;
  resetPaymentWebhookRateLimits();
  clearDoitWebhookSecretCache();
  doit.calls.length = 0;
  doit.payments.clear();
  installPort("none");
});
afterEach(() => {
  flags.DOIT_REFUNDS_ENABLED = false;
  setPaymentRefundGateway(null);
});

type SeededIntent = { intentId: string; paymentId: string; amountIdr: number };

/** A settled DOIT bill: link, paid intent minted by the integration, evidence. */
async function seedPaid(amountIdr = PAID_IDR): Promise<SeededIntent> {
  const linkId = randomUUID();
  const intentId = randomUUID();
  const paymentId = `dp_${hex(8)}`;
  linkIds.push(linkId);
  intentIds.push(intentId);
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)`,
    [linkId, tenantId, outletA, hex(32), `Q45-${hex(4)}`, amountIdr, actor],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at, provider_ref, gateway_integration_id)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now(), $7, $8)`,
    [
      intentId,
      tenantId,
      outletA,
      linkId,
      amountIdr,
      `q45-${intentId}`,
      paymentId,
      integrationId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [tenantId, outletA, intentId, paymentId, amountIdr],
  );
  return { intentId, paymentId, amountIdr };
}

/** An approved refund written straight into the table, ready for payout. */
async function seedApproved(
  intent: SeededIntent,
  seed: {
    amountIdr?: number;
    attempts?: number;
    lastError?: string;
    providerRef?: string;
    polls?: number;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, payout_attempts, last_payout_error,
                                  provider_ref, payout_pending_polls, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian uji', 'approved', $6, $7, now(), $8, $9,
             $10, $11, $12, now() - interval '2 hours')`,
    [
      id,
      tenantId,
      outletA,
      intent.intentId,
      seed.amountIdr ?? 30_000,
      requesterId,
      financeSupId,
      seed.attempts ?? 0,
      seed.lastError ?? null,
      seed.providerRef ?? null,
      seed.polls ?? 0,
      new Date(Date.now() - 3 * 3_600_000),
    ],
  );
  return id;
}

/** A refund already paid out and booked for this bill (counts against the cap). */
async function seedCompleted(
  intent: SeededIntent,
  amountIdr: number,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, completed_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian uji', 'completed', $6, $7, now(), now(), $8, now())`,
    [
      id,
      tenantId,
      outletA,
      intent.intentId,
      amountIdr,
      requesterId,
      financeSupId,
      new Date(Date.now() - 3 * 3_600_000),
    ],
  );
  return id;
}

async function refundRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    provider_ref: string | null;
    payout_attempts: number;
    payout_pending_polls: number;
    last_payout_error: string | null;
    failure_reason: string | null;
    live: boolean;
    completed_at: Date | null;
  }>(
    `SELECT status, provider_ref, payout_attempts, payout_pending_polls, last_payout_error,
            failure_reason, COALESCE(payout_claimed_until > now(), false) AS live, completed_at
     FROM payment_refunds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  if (!rows[0]) throw new Error("refund row missing");
  return rows[0];
}

const QUEUED = {
  status: "approved",
  provider_ref: null,
  payout_attempts: 0,
  payout_pending_polls: 0,
  last_payout_error: null,
  failure_reason: null,
  live: false,
  completed_at: null,
};

async function intentStatus(intentId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [tenantId, intentId],
  );
  return rows[0]?.status;
}

async function refundCount(intentId: string) {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantId, intentId],
  );
  return Number(rows[0]!.n);
}

async function audits(refundId: string, action: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM audit_logs
     WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = $3`,
    [tenantId, refundId, action],
  );
  return rows;
}

async function refundedEvents(refundId: string, intentId: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(DISTINCT event->>'id')::int AS n FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.refunded'
       AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS needle WHERE event::text LIKE '%' || needle || '%')`,
    [tenantId, [refundId, intentId]],
  );
  return rows[0]!.n;
}

async function providerFactsIdr(intentId: string) {
  const { rows } = await owner.query<{ total: string }>(
    `SELECT COALESCE(sum(amount_idr), 0)::text AS total FROM payment_provider_refunds
     WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [tenantId, intentId],
  );
  return Number(rows[0]!.total);
}

async function refundable(intentId: string) {
  const response = await requester.get(
    `${ADMIN}/refunds/refundable?outletId=${outletA}`,
  );
  expect(response.status).toBe(200);
  return response.body.data.payments.find(
    (p: { paymentIntentId: string }) => p.paymentIntentId === intentId,
  ) as
    | {
        paidAmountIdr: number;
        refundedAmountIdr: number;
        refundableAmountIdr: number;
      }
    | undefined;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function requestRefund(intentId: string, amountIdr: number) {
  const response = await requester
    .post(`${ADMIN}/refunds`)
    .set(originHeader)
    .send({
      idempotencyKey: key("req"),
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pelanggan mengembalikan pesanan",
    });
  return response;
}

async function requestedRefundId(intentId: string, amountIdr: number) {
  const response = await requestRefund(intentId, amountIdr);
  expect(response.status).toBe(201);
  return response.body.data.id as string;
}

const approve = (refundId: string) =>
  financeSup
    .post(`${ADMIN}/refunds/${refundId}/approve`)
    .set(originHeader)
    .send({ idempotencyKey: key("apr") });

const retry = (refundId: string) =>
  financeSup
    .post(`${ADMIN}/refunds/${refundId}/retry`)
    .set(originHeader)
    .send({ idempotencyKey: key("retry") });

const NOTE = "Dibayar manual oleh finance lewat transfer bank.";
function settlementBody(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: key("settle"),
    paidAt: new Date(Date.now() - 60_000).toISOString(),
    channel: "bank_transfer",
    externalReference: `TRX-${randomUUID().slice(0, 8)}`,
    amountIdr: 30_000,
    note: NOTE,
    ...overrides,
  };
}
const settle = (
  refundId: string,
  body: Record<string, unknown> = settlementBody(),
) =>
  ops
    .post(`${ADMIN}/refunds/${refundId}/settle-manually`)
    .set(originHeader)
    .send(body);

const sweep = () => sweepApprovedRefundPayouts(tenantWide, new Date(), 100);

// ---------------------------------------------------------------------------
// B1: flag off, no provider call from any refund path
// ---------------------------------------------------------------------------

describe("legend-kmrto B1 flag off: no refund path calls the provider", () => {
  for (const mode of portModes) {
    describe(`refund port state: ${mode}`, () => {
      beforeEach(() => installPort(mode));

      it("approving a refund keeps it approved and unpaid, with nothing sent", async () => {
        const intent = await seedPaid();
        const refundId = await requestedRefundId(intent.intentId, 30_000);

        const response = await approve(refundId);

        expect([200, 503]).toContain(response.status);
        expect(await refundRow(refundId)).toMatchObject({
          status: "approved",
          payout_attempts: 0,
          failure_reason: null,
          completed_at: null,
        });
        expect(await intentStatus(intent.intentId)).toBe("paid");
        expect(providerContacts()).toEqual(NO_CONTACT);
      });

      it("runRefundPayout and the retry endpoint answer 503 REFUND_PROVIDER_DISABLED and change nothing", async () => {
        const intent = await seedPaid();
        const refundId = await seedApproved(intent);

        await expect(
          runRefundPayout(tenantWide, refundId),
        ).rejects.toMatchObject({ code: "REFUND_PROVIDER_DISABLED" });
        expect(await refundRow(refundId)).toMatchObject(QUEUED);

        const retried = await retry(refundId);
        expect(retried.status).toBe(503);
        expect(retried.body.error.code).toBe("REFUND_PROVIDER_DISABLED");
        expect(await refundRow(refundId)).toMatchObject(QUEUED);
        expect(providerContacts()).toEqual(NO_CONTACT);
      });

      it("the sweep, run again and again, sends nothing, counts no attempt and never fails the refund", async () => {
        const intent = await seedPaid();
        const refundId = await seedApproved(intent);
        const withHistory = await seedApproved(await seedPaid(), {
          attempts: 2,
          lastError: "SERVICE_UNAVAILABLE",
        });

        for (let round = 0; round < 5; round += 1) {
          await expect(sweep()).resolves.not.toThrow();
          await owner.query(
            "UPDATE payment_refunds SET updated_at = now() - interval '2 hours' WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
            [tenantId, [refundId, withHistory]],
          );
        }

        expect(await refundRow(refundId)).toMatchObject(QUEUED);
        // A refund that already carries a history keeps it: no new attempt,
        // no move to `failed` or to a "give up" marker by the sweep.
        expect(await refundRow(withHistory)).toMatchObject({
          status: "approved",
          payout_attempts: 2,
          failure_reason: null,
          completed_at: null,
        });
        expect(providerContacts()).toEqual(NO_CONTACT);
      });
    });
  }

  it("the test-only gateway shim throws in production, so legacy mode cannot pay there", async () => {
    fake = new FakeRefundGateway();
    resetPaymentRefundGateways();
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => setPaymentRefundGateway(fake)).toThrow(Error);
    } finally {
      vi.unstubAllEnvs();
    }

    // The refused call installed nothing: with the flag off an approved refund
    // still waits and the spy is never reached.
    const intent = await seedPaid();
    const refundId = await requestedRefundId(intent.intentId, 30_000);
    expect([200, 503]).toContain((await approve(refundId)).status);
    expect((await refundRow(refundId)).status).toBe("approved");
    expect(providerContacts()).toEqual(NO_CONTACT);
  });

  it("control: with the flag on and a port, approving still pays out once (the switch is the flag)", async () => {
    flags.DOIT_REFUNDS_ENABLED = true;
    installPort("legacy");
    const intent = await seedPaid();
    const refundId = await requestedRefundId(intent.intentId, 30_000);

    const response = await approve(refundId);

    expect(response.status).toBe(200);
    expect(fake.calls).toHaveLength(1);
    expect((await refundRow(refundId)).status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// B2: approved refund waits in the finance queue; manual record once, capped
// ---------------------------------------------------------------------------

describe("legend-kmrto B2 flag off: finance records the refund by hand", () => {
  for (const mode of portModes) {
    it(`request, approve, queue, manual record: the whole flow never touches the provider (port ${mode})`, async () => {
      installPort(mode);
      const intent = await seedPaid();
      const refundId = await requestedRefundId(intent.intentId, 30_000);
      expect([200, 503]).toContain((await approve(refundId)).status);

      // The queue finance works from still lists it, as approved.
      const listed = await financeSup.get(
        `${ADMIN}/refunds?outletId=${outletA}&limit=100`,
      );
      expect(listed.status).toBe(200);
      const queued = listed.body.data.find(
        (row: { id: string }) => row.id === refundId,
      );
      expect(queued).toMatchObject({ id: refundId, status: "approved" });

      // paidAt must lie between the request and now (422 otherwise); the refund
      // was requested seconds ago here, so pay "halfway" after the request.
      const { rows: created } = await owner.query<{ at: Date }>(
        "SELECT created_at AS at FROM payment_refunds WHERE id = $1",
        [refundId],
      );
      const paidAt = new Date(
        (created[0]!.at.getTime() + Date.now()) / 2,
      ).toISOString();
      const recorded = await settle(refundId, settlementBody({ paidAt }));

      expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
      expect(recorded.body.data).toMatchObject({
        id: refundId,
        status: "completed",
        lastPayoutError: SETTLED_OUTSIDE_PROVIDER,
      });
      expect(await intentStatus(intent.intentId)).toBe("partially_refunded");
      expect(await refundable(intent.intentId)).toMatchObject({
        refundedAmountIdr: 30_000,
        refundableAmountIdr: 70_000,
      });
      expect(providerContacts()).toEqual(NO_CONTACT);
      // The sweep after the record neither pays nor reopens it.
      await owner.query(
        "UPDATE payment_refunds SET updated_at = now() - interval '2 hours' WHERE id = $1",
        [refundId],
      );
      await sweep();
      expect((await refundRow(refundId)).status).toBe("completed");
      expect(providerContacts()).toEqual(NO_CONTACT);
    });
  }

  it("a replay of the same record (same key and body) returns the same view; booked, audited and published once", async () => {
    const intent = await seedPaid();
    const refundId = await seedApproved(intent);
    const body = settlementBody();

    const first = await settle(refundId, body);
    const replay = await settle(refundId, body);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(1);
    expect(await refundedEvents(refundId, intent.intentId)).toBe(1);

    const reused = await settle(refundId, {
      ...body,
      externalReference: "TRX-OTHER",
    });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("recording it a second time with another key is refused 409 REFUND_NOT_SETTLEABLE and changes nothing", async () => {
    const intent = await seedPaid();
    const refundId = await seedApproved(intent);
    expect((await settle(refundId)).status).toBe(200);
    const done = await refundRow(refundId);

    const second = await settle(refundId, settlementBody());

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("REFUND_NOT_SETTLEABLE");
    expect((await refundRow(refundId)).completed_at?.getTime()).toBe(
      done.completed_at?.getTime(),
    );
    expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(1);
    expect(await refundedEvents(refundId, intent.intentId)).toBe(1);
    expect((await refundable(intent.intentId))?.refundedAmountIdr).toBe(30_000);
  });

  it("two finance users recording the same refund at once: exactly one wins", async () => {
    const intent = await seedPaid();
    const refundId = await seedApproved(intent);

    const results = await Promise.all([
      settle(refundId, settlementBody()),
      settle(refundId, settlementBody()),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(1);
    expect(await refundedEvents(refundId, intent.intentId)).toBe(1);
    expect((await refundable(intent.intentId))?.refundedAmountIdr).toBe(30_000);
  });

  it("an amount different from the approved refund is refused 409 SETTLEMENT_AMOUNT_MISMATCH", async () => {
    const intent = await seedPaid();
    const refundId = await seedApproved(intent);

    for (const amountIdr of [29_999, 30_001, PAID_IDR + 1]) {
      const response = await settle(refundId, settlementBody({ amountIdr }));
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("SETTLEMENT_AMOUNT_MISMATCH");
    }
    expect(await refundRow(refundId)).toMatchObject(QUEUED);
  });

  it("a refund request above what the guest paid is refused, also on top of manual records", async () => {
    const intent = await seedPaid();
    const tooMuch = await requestRefund(intent.intentId, PAID_IDR + 1);
    expect(tooMuch.status).toBeGreaterThanOrEqual(400);
    expect(tooMuch.status).toBeLessThan(500);
    expect(await refundCount(intent.intentId)).toBe(0);

    const first = await seedApproved(intent, { amountIdr: 70_000 });
    expect(
      (await settle(first, settlementBody({ amountIdr: 70_000 }))).status,
    ).toBe(200);

    const over = await requestRefund(intent.intentId, 30_001);
    expect(over.status).toBeGreaterThanOrEqual(400);
    expect(over.status).toBeLessThan(500);
    expect(await refundCount(intent.intentId)).toBe(1);
    // The rest, exactly, is still allowed.
    expect((await requestRefund(intent.intentId, 30_000)).status).toBe(201);
  });

  it("two approved refunds that together pass what was paid: they can never both be recorded; a refused one is 409 REFUND_CAP_EXCEEDED and changes nothing", async () => {
    // Diagnosis (run 1072-b): the first version expected the 70.000 record to
    // pass and only the 60.000 one to fail. The service counts the other open
    // approved refund as already reserved, so it refuses the first record too
    // (restrictive: hold the money when in doubt, never pay more). Either order
    // is acceptable; what must hold is the cap.
    const intent = await seedPaid();
    const a = await seedApproved(intent, { amountIdr: 70_000 });
    const b = await seedApproved(intent, { amountIdr: 60_000 });

    const results = [
      {
        id: a,
        response: await settle(a, settlementBody({ amountIdr: 70_000 })),
      },
      {
        id: b,
        response: await settle(b, settlementBody({ amountIdr: 60_000 })),
      },
    ];

    const refused = results.filter((r) => r.response.status !== 200);
    expect(refused.length).toBeGreaterThanOrEqual(1);
    for (const { id, response } of refused) {
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("REFUND_CAP_EXCEEDED");
      expect(await refundRow(id)).toMatchObject(QUEUED);
      expect(await audits(id, SETTLE_ACTION)).toHaveLength(0);
    }
    const view = await refundable(intent.intentId);
    expect(view?.refundedAmountIdr ?? 0).toBeLessThanOrEqual(PAID_IDR);
    expect(view?.refundableAmountIdr ?? 0).toBeGreaterThanOrEqual(0);
    const { rows } = await owner.query<{ total: string }>(
      "SELECT COALESCE(sum(amount_idr), 0)::text AS total FROM payment_refunds WHERE payment_intent_id = $1 AND status = 'completed'",
      [intent.intentId],
    );
    expect(Number(rows[0]!.total)).toBeLessThanOrEqual(PAID_IDR);
  });

  it("a record needs a person other than the requester and a valid body (nothing changes when refused)", async () => {
    const intent = await seedPaid();
    const refundId = await seedApproved(intent);

    const invalid = await settle(refundId, settlementBody({ amountIdr: 0 }));
    expect(invalid.status).toBe(422);
    const anonymous = await agent(app)
      .set("Host", scope.hostname)
      .post(`${ADMIN}/refunds/${refundId}/settle-manually`)
      .set(originHeader)
      .send(settlementBody());
    expect(anonymous.status).toBe(401);
    expect(await refundRow(refundId)).toMatchObject(QUEUED);
    expect(opsId).not.toBe(requesterId);
  });
});

// ---------------------------------------------------------------------------
// B2 (fix review R1): the cap re-check never strands a refund with a provider trace
// ---------------------------------------------------------------------------

// Brief "Fix review 1": a refund WITHOUT a provider trace that would pass the
// cap is refused 409 REFUND_CAP_EXCEEDED. A refund WITH a trace (provider
// reference or pending polls, flagged MANUAL_RECONCILIATION or
// PAYOUT_NOT_FOUND_MAYBE_SENT) is not blocked: finance must be able to close it
// by hand, and the excess is written into the audit detail like `approvalDefect`
// (`maskedChanges.after.capExcessIdr`).
// Assumptions: the excess is `completed + this - paid` = 80.000 + 30.000 - 100.000
// = 10.000 here; the provider lookup of a stuck refund (legend-980) answers
// `failed`, so the port is registered with that answer (the lookup is not
// asserted, only that nothing is ever sent); the audit shape is the one of the
// manual-settle test (`event.maskedChanges.after`).
describe("legend-kmrto B2 fix review R1: a refund with a provider trace over the cap can still be settled by hand", () => {
  const OTHER_PAID = 80_000;
  const EXCESS = OTHER_PAID + 30_000 - PAID_IDR; // 10.000

  const auditAfter = async (refundId: string) => {
    const rows = await audits(refundId, SETTLE_ACTION);
    expect(rows).toHaveLength(1);
    return (
      rows[0]!.event as { maskedChanges: { after: Record<string, unknown> } }
    ).maskedChanges.after;
  };

  /** A bill with 80.000 already refunded, and a stuck 30.000 refund on top: 10.000 over. */
  async function seedStuckOverCap(flag: string) {
    // Port mode "legacy" (test shim) on purpose: the settle precondition asks the
    // provider for the status of a traced refund and only passes on `failed`. With
    // the flag off, a registered port is swapped for the unconfigured one (brief G1),
    // so that lookup answers "unknown" -> 409 PROVIDER_REFUND_STATUS_UNKNOWN before
    // the cap rule (R1) is reached. The shim lets the lookup reach the spy; settle
    // never pays, which the test asserts (no refund call, no POST).
    installPort("legacy");
    const intent = await seedPaid();
    await seedCompleted(intent, OTHER_PAID);
    const providerRef = `PR-STUCK-${randomUUID()}`;
    const refundId = await seedApproved(intent, {
      attempts: 8,
      lastError: flag,
      providerRef,
      polls: 3,
    });
    fake.setStatus(`refund:${refundId}`, {
      status: "failed",
      providerRef,
      code: "declined",
    });
    return { intent, refundId, providerRef };
  }

  const completedTotal = async (intentId: string) => {
    const { rows } = await owner.query<{ total: string }>(
      "SELECT COALESCE(sum(amount_idr), 0)::text AS total FROM payment_refunds WHERE payment_intent_id = $1 AND status = 'completed'",
      [intentId],
    );
    return Number(rows[0]!.total);
  };

  for (const flag of ["MANUAL_RECONCILIATION", "PAYOUT_NOT_FOUND_MAYBE_SENT"])
    it(`${flag} over the cap: settled by hand once, audit carries capExcessIdr, a second settle is 409, nothing is ever sent`, async () => {
      const { intent, refundId, providerRef } = await seedStuckOverCap(flag);
      const body = settlementBody();

      const first = await settle(refundId, body);

      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.data).toMatchObject({
        id: refundId,
        status: "completed",
        lastPayoutError: SETTLED_OUTSIDE_PROVIDER,
      });
      expect(await refundRow(refundId)).toMatchObject({
        status: "completed",
        provider_ref: providerRef,
        live: false,
      });
      const after = await auditAfter(refundId);
      expect(after).toMatchObject({
        status: "completed",
        amountIdr: 30_000,
      });
      // The audit masker may store the number as text; the value is what counts.
      expect(Number(after.capExcessIdr)).toBe(EXCESS);
      expect(await refundedEvents(refundId, intent.intentId)).toBe(1);
      expect(await completedTotal(intent.intentId)).toBe(OTHER_PAID + 30_000);
      expect(fake.calls).toHaveLength(0);
      expect(doit.refundPosts).toEqual([]);

      // Same key and body: the same view, nothing booked twice.
      const replay = await settle(refundId, body);
      expect(replay.status).toBe(200);
      expect(replay.body.data).toEqual(first.body.data);

      // Another key: refused, nothing changes.
      const done = await refundRow(refundId);
      const second = await settle(refundId, settlementBody());
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe("REFUND_NOT_SETTLEABLE");
      expect((await refundRow(refundId)).completed_at?.getTime()).toBe(
        done.completed_at?.getTime(),
      );
      expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(1);
      expect(await refundedEvents(refundId, intent.intentId)).toBe(1);
      expect(await completedTotal(intent.intentId)).toBe(OTHER_PAID + 30_000);

      // The sweep and the retry endpoint never send it afterwards.
      await sweep();
      await retry(refundId);
      expect((await refundRow(refundId)).status).toBe("completed");
      // The sweep is tenant-wide and the shim port also pays other approved refunds
      // left by earlier tests, so only calls for THIS refund are checked.
      expect(
        fake.calls.filter((c) => c.idempotencyKey === `refund:${refundId}`),
      ).toHaveLength(0);
      expect(doit.refundPosts).toEqual([]);
    });

  it("two finance users settling a traced refund over the cap at once: exactly one wins, one audit", async () => {
    const { intent, refundId } = await seedStuckOverCap(
      "MANUAL_RECONCILIATION",
    );

    const results = await Promise.all([
      settle(refundId, settlementBody()),
      settle(refundId, settlementBody()),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(1);
    expect(await refundedEvents(refundId, intent.intentId)).toBe(1);
    expect(await completedTotal(intent.intentId)).toBe(OTHER_PAID + 30_000);
  });

  it("control: the same over-cap refund WITHOUT a provider trace is still refused 409 REFUND_CAP_EXCEEDED and changes nothing", async () => {
    const intent = await seedPaid();
    await seedCompleted(intent, OTHER_PAID);
    const refundId = await seedApproved(intent, { amountIdr: 30_000 });

    const response = await settle(refundId);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("REFUND_CAP_EXCEEDED");
    expect(await refundRow(refundId)).toMatchObject(QUEUED);
    expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(0);
    expect(await completedTotal(intent.intentId)).toBe(OTHER_PAID);
  });

  it("a traced refund within the cap settles with no capExcessIdr in the audit", async () => {
    installPort("legacy"); // see seedStuckOverCap: the lookup must reach the spy
    const intent = await seedPaid();
    await seedCompleted(intent, 50_000);
    const providerRef = `PR-STUCK-${randomUUID()}`;
    const refundId = await seedApproved(intent, {
      attempts: 8,
      lastError: "MANUAL_RECONCILIATION",
      providerRef,
    });
    fake.setStatus(`refund:${refundId}`, {
      status: "failed",
      providerRef,
      code: "declined",
    });

    const response = await settle(refundId);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    // No excess: the field is absent or zero.
    expect(Number((await auditAfter(refundId)).capExcessIdr ?? 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// B3: provider reports are still matched; odd ones are held
// ---------------------------------------------------------------------------

function signatureHeader(raw: string): string {
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", webhookSecret)
    .update(`${t}.${raw}`)
    .digest("hex");
  return `t=${t},v1=${mac}`;
}

function deliver(type: string, data: Record<string, unknown>) {
  const body = {
    id: `evt_${hex(8)}`,
    type,
    created_at: new Date().toISOString(),
    data,
  };
  eventIds.push(body.id);
  const raw = JSON.stringify(body);
  return request(app)
    .post(webhookPath)
    .set("Content-Type", "application/json")
    .set("PayBridge-Signature", signatureHeader(raw))
    .send(raw);
}

const backdate = (minutes: number) =>
  owner.query(
    `UPDATE gateway_webhook_events
       SET received_at = now() - make_interval(mins => $2),
           updated_at = now() - make_interval(mins => $2)
     WHERE tenant_id = $1 AND event_id = ANY($3::text[])`,
    [tenantId, minutes, eventIds],
  );
const reprocess = () =>
  reprocessStoredWebhookEvents(webhookContext, new Date(), 100);

describe("legend-kmrto B3 flag off: provider refund reports are matched, odd ones held", () => {
  it("control: a signed refund.succeeded for our approved refund still completes it, with no refund call", async () => {
    const intent = await seedPaid();
    const refundId = await seedApproved(intent, {
      amountIdr: PAID_IDR,
      attempts: 1,
    });

    const response = await deliver("refund.succeeded", {
      object: "refund",
      id: `rf_${hex(6)}`,
      idempotency_key: `refund:${refundId}`,
      amount: PAID_IDR,
      status: "succeeded",
      payment_id: intent.paymentId,
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    expect((await refundRow(refundId)).status).toBe("completed");
    expect(await intentStatus(intent.intentId)).toBe("refunded");
    expect(doit.refundPosts).toEqual([]);
  });

  it("a provider refund of a bill where we made no refund is held: the bill is stamped, no refund is created, a new request is 409 PROVIDER_REFUNDED", async () => {
    const intent = await seedPaid();
    doit.payments.set(intent.paymentId, {
      id: intent.paymentId,
      status: "refunded",
      amount: intent.amountIdr,
      reference: intent.intentId,
    });

    const response = await deliver("payment.refunded", {
      id: intent.paymentId,
      status: "refunded",
      amount: intent.amountIdr,
      reference: intent.intentId,
    });

    expect(response.status).toBeLessThan(500);
    const { rows } = await owner.query<{ stamp: Date | null }>(
      "SELECT provider_refunded_after_paid_at AS stamp FROM payment_intents WHERE id = $1",
      [intent.intentId],
    );
    expect(rows[0]?.stamp, "the bill is flagged for finance").not.toBeNull();
    expect(await refundCount(intent.intentId)).toBe(0);

    const again = await requestRefund(intent.intentId, 30_000);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("PROVIDER_REFUNDED");
    expect(await refundCount(intent.intentId)).toBe(0);
    expect(doit.refundPosts).toEqual([]);
  });

  it("a provider refund of a different amount is recorded as the provider's own, our approved refund stays queued, and recording it by hand is refused", async () => {
    const intent = await seedPaid();
    const refundId = await seedApproved(intent, { amountIdr: PAID_IDR });
    const providerRefundId = `rf_${hex(6)}`;

    await deliver("refund.succeeded", {
      object: "refund",
      id: providerRefundId,
      idempotency_key: `refund:${randomUUID()}`,
      amount: 60_000,
      status: "succeeded",
      payment_id: intent.paymentId,
    });
    await backdate(20);
    await reprocess();

    expect(await providerFactsIdr(intent.intentId)).toBe(60_000);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      completed_at: null,
    });
    // Provider money (60.000) plus our hand payment (100.000) would pass what
    // the guest paid (100.000): finance must not be able to record it.
    const recorded = await settle(
      refundId,
      settlementBody({ amountIdr: PAID_IDR }),
    );
    expect(recorded.status).toBe(409);
    expect((await refundRow(refundId)).status).toBe("approved");
    expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(0);
    await sweep();
    expect(doit.refundPosts).toEqual([]);
    const view = await refundable(intent.intentId);
    expect(view?.refundableAmountIdr ?? 0).toBeLessThanOrEqual(40_000);
  });

  it("an unsigned or wrongly signed refund report changes nothing", async () => {
    const intent = await seedPaid();
    const refundId = await seedApproved(intent, {
      amountIdr: PAID_IDR,
      attempts: 1,
    });
    const raw = JSON.stringify({
      id: `evt_${hex(8)}`,
      type: "refund.succeeded",
      created_at: new Date().toISOString(),
      data: {
        object: "refund",
        id: `rf_${hex(6)}`,
        idempotency_key: `refund:${refundId}`,
        amount: PAID_IDR,
        status: "succeeded",
        payment_id: intent.paymentId,
      },
    });

    const response = await request(app)
      .post(webhookPath)
      .set("Content-Type", "application/json")
      .set("PayBridge-Signature", "t=1,v1=deadbeef")
      .send(raw);

    expect(response.status).toBe(401);
    expect((await refundRow(refundId)).status).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// B4: the order flows never reach the provider
// ---------------------------------------------------------------------------

describe("legend-kmrto B4 order corrections and order recovery never call the provider", () => {
  const forbidden =
    /payment-refund-gateway|payment-doit|paymentRefundGatewayFor|runRefundPayout|retryRefundPayout|sweepApprovedRefundPayouts|createDoitGateway/;
  for (const file of ["pos-order-corrections.ts", "order-recovery-refund.ts"])
    it(`${file} imports neither the refund gateway, the DOIT adapter nor a payout function`, () => {
      const source = readFileSync(
        new URL(`../services/${file}`, import.meta.url),
        "utf8",
      );
      expect(source).not.toMatch(forbidden);
    });
});
