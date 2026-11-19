// Atomic claim and lease of the DOIT pending poller (legend-rfiof, review K).
//
// `pollPendingGatewayIntents` claims intents with `FOR UPDATE SKIP LOCKED` and
// stamps `payment_intents.gateway_poll_lease_until` (GATEWAY_POLL_LEASE_MS),
// then frees the lease in a `finally`. These tests prove, through the real
// service and a fake DOIT server:
// - two concurrent runs ask DOIT about each pending intent exactly once;
// - the lease is null after a run, also when DOIT fails or drops the call;
// - a live lease is skipped, an elapsed lease (dead worker) is taken again;
// - the `limit` argument is honoured.
//
// Isolation: the test database is shared by all files (run serially), and the
// poller is tenant-wide. `beforeEach` therefore parks every existing intent of
// the tenant behind a far-future lease, and `afterAll` restores them, so the
// counts here are exact.
import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { createDoitGateway } from "../services/payment-doit";
import { setPaymentGateway } from "../services/payment-gateway";
import {
  createPaymentLink,
  pollPendingGatewayIntents,
} from "../services/payment.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import { agent } from "./helpers";

const app = createApp();
const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const actor = randomUUID();
const BILL_TOTAL = 144_375;
/** Marker lease that parks foreign intents; restored in afterAll. */
const PARKED_LEASE = "2999-01-01T00:00:00.000Z";

const apiKey = `doit-key-l-${randomBytes(12).toString("hex")}`;
const secret = `whsec-l-${randomBytes(16).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdLinkIds: string[] = [];
let integrationId = "";

const unique = () => randomBytes(4).toString("hex");

function tenantContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantA,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

function outletContext(outletIds: readonly OutletId[]): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantA,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [...outletIds] },
  );
}

// ---------------------------------------------------------------------------
// Fake DOIT server: counts status reads per payment id, can answer slowly,
// fail with HTTP 500, or drop the connection.
// ---------------------------------------------------------------------------

type DoitPayment = {
  id: string;
  status: "pending" | "paid" | "refunded" | "expired" | "failed";
  amount: number;
  rail: string | null;
  reference: string;
  qr_content: string | null;
  va_number: string | null;
  va_bank: string | null;
  hosted_url: string | null;
  return_url: string | null;
  provider: string;
  provider_ref: string | null;
  fee_amount: number;
  fee_payer: string;
  total_amount: number;
  expires_at: string;
  paid_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type FailMode = "http500" | "drop" | null;

class FakeDoit {
  private readonly payments = new Map<string, DoitPayment>();
  private readonly byIdempotencyKey = new Map<string, DoitPayment>();
  /** Status reads (GET /v1/payments/:id) per payment id. */
  readonly statusReads = new Map<string, number>();
  /** Answer status reads slowly so two concurrent runs overlap. */
  readDelayMs = 0;
  /** How status reads fail; creation always works. */
  failMode: FailMode = null;
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

  reset(): void {
    this.statusReads.clear();
    this.readDelayMs = 0;
    this.failMode = null;
  }

  readsOf(id: string): number {
    return this.statusReads.get(id) ?? 0;
  }

  totalReads(): number {
    let total = 0;
    for (const n of this.statusReads.values()) total += n;
    return total;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.headers.authorization !== `Bearer ${apiKey}`)
      return send(401, {
        error: { code: "unauthorized", message: "Invalid API key" },
      });
    if (req.method === "GET" && url.pathname === "/v1/methods")
      return send(200, {
        environment: "sandbox",
        amount: null,
        data: [
          {
            code: "qris",
            label: "QRIS",
            rail: "qris",
            bank: null,
            fee_flat: 0,
            fee_pct: 0,
            fee_payer: "merchant",
            min_amount: null,
            max_amount: null,
            fee_amount: 0,
            total_amount: null,
            within_limits: true,
            limit: null,
          },
        ],
      });
    if (req.method === "POST" && url.pathname === "/v1/payments") {
      const key = String(req.headers["idempotency-key"] ?? "");
      const known = this.byIdempotencyKey.get(key);
      if (known) return send(200, known);
      const input = JSON.parse(body) as {
        amount: number;
        rail: string;
        reference: string;
        expires_in: number;
      };
      const id = `dp_${randomBytes(8).toString("hex")}`;
      const createdAt = new Date();
      const payment: DoitPayment = {
        id,
        status: "pending",
        amount: input.amount,
        rail: input.rail,
        reference: input.reference,
        qr_content: "00020101021226610014ID.CO.DOIT.FAKE",
        va_number: null,
        va_bank: null,
        hosted_url: `https://pay.doit.id/p/${id}`,
        return_url: null,
        provider: "pjp",
        provider_ref: null,
        fee_amount: 0,
        fee_payer: "merchant",
        total_amount: input.amount,
        expires_at: new Date(
          createdAt.getTime() + input.expires_in * 1000,
        ).toISOString(),
        paid_at: null,
        metadata: null,
        created_at: createdAt.toISOString(),
      };
      this.payments.set(payment.id, payment);
      if (key) this.byIdempotencyKey.set(key, payment);
      return send(201, payment);
    }
    const found = /^\/v1\/payments\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && found) {
      const id = decodeURIComponent(found[1]!);
      this.statusReads.set(id, this.readsOf(id) + 1);
      if (this.readDelayMs > 0)
        await new Promise((accept) => setTimeout(accept, this.readDelayMs));
      if (this.failMode === "drop") return req.socket.destroy();
      if (this.failMode === "http500")
        return send(500, { error: { code: "internal", message: "boom" } });
      const payment = this.payments.get(id);
      return payment ? send(200, payment) : send(404, { error: "not_found" });
    }
    return send(404, { error: "not_found" });
  }
}

const doit = new FakeDoit();

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await doit.start();
  const context = tenantContext();
  const created = await upsertIntegration(
    context,
    {
      outletId: null,
      provider: "doit",
      config: { baseUrl: doit.baseUrl },
      credentials: { apiKey, webhookSecret: secret },
    },
    actor,
  );
  await setIntegrationStatus(context, created.id, { status: "active" }, actor);
  integrationId = created.id;
  setPaymentGateway(
    createDoitGateway({
      loadCredentials: async () => ({
        integration: {
          id: integrationId,
          outletId: null,
          config: { baseUrl: doit.baseUrl },
        },
        credentials: { apiKey, webhookSecret: secret },
      }),
    }),
  );
});

afterAll(async () => {
  setPaymentGateway(null);
  // Hand foreign intents back to the files that own them.
  await owner.query(
    "UPDATE payment_intents SET gateway_poll_lease_until = NULL WHERE tenant_id = $1 AND gateway_poll_lease_until = $2",
    [tenantA, PARKED_LEASE],
  );
  if (createdLinkIds.length > 0) {
    const intents =
      "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
    await owner.query(
      `DELETE FROM refund_recon_holds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantA, createdLinkIds],
    );
    await owner.query(
      `DELETE FROM payment_provider_refunds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantA, createdLinkIds],
    );
    await owner.query(
      `DELETE FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantA, createdLinkIds],
    );
    await owner.query(
      `DELETE FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantA, createdLinkIds],
    );
    await owner.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [tenantA, createdLinkIds],
    );
    await owner.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantA, createdLinkIds],
    );
  }
  await owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
    integrationId,
  ]);
  await owner.end();
  await doit.stop();
});

beforeEach(async () => {
  doit.reset();
  // Park every existing intent (leftovers of other files and of earlier tests
  // here) so each test only sees the intents it creates.
  await owner.query(
    `UPDATE payment_intents SET gateway_poll_lease_until = $2
      WHERE tenant_id = $1 AND gateway_poll_lease_until IS NULL`,
    [tenantA, PARKED_LEASE],
  );
});

type Intent = { id: string; providerRef: string };

/** A bill with one pending QRIS code. One code per bill: a second code on the
 * same bill would supersede (expire) the first. */
async function pendingIntent(): Promise<Intent> {
  const opened = await createPaymentLink(
    outletContext([outletA]),
    {
      outletId: outletA,
      reference: `L-${unique()}`,
      tableLabel: "A05",
      pax: 2,
      subtotalIdr: 125_000,
      discountIdr: 0,
      serviceChargeIdr: 6_250,
      taxIdr: 13_125,
      roundingIdr: 0,
      totalIdr: BILL_TOTAL,
      returnPath: "/t/v1.abc",
    },
    "00000000-0000-4000-8000-000000000001",
  );
  createdLinkIds.push(opened.linkId);
  const created = await agent(app)
    .post(`/api/payments/links/${opened.token}/intents`)
    .send({
      method: "qris",
      channelCode: null,
      idempotencyKey: `k-${unique()}`,
    });
  expect(created.status).toBe(201);
  const id = created.body.data.id as string;
  const { rows } = await owner.query<{ provider_ref: string | null }>(
    "SELECT provider_ref FROM payment_intents WHERE id = $1",
    [id],
  );
  const providerRef = rows[0]?.provider_ref;
  if (!providerRef) throw new Error("Intent has no DOIT payment id");
  return { id, providerRef };
}

async function pendingIntents(n: number): Promise<Intent[]> {
  const intents: Intent[] = [];
  for (let i = 0; i < n; i += 1) intents.push(await pendingIntent());
  return intents;
}

/** Poll time: past the 60 s grace period so fresh intents are eligible. */
const pollTime = () => new Date(Date.now() + 120_000);

async function intentRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    lease: Date | null;
  }>(
    "SELECT status, gateway_poll_lease_until AS lease FROM payment_intents WHERE id = $1",
    [id],
  );
  return rows[0]!;
}

async function setLease(id: string, lease: Date | null) {
  await owner.query(
    "UPDATE payment_intents SET gateway_poll_lease_until = $2 WHERE id = $1",
    [id, lease],
  );
}

async function expectAllLeasesReleased(intents: Intent[]) {
  for (const intent of intents)
    expect((await intentRow(intent.id)).lease).toBeNull();
}

describe("DOIT poller lease", () => {
  it("two concurrent runs ask DOIT about each pending intent exactly once", async () => {
    const intents = await pendingIntents(4);
    // Slow answers keep the first run busy while the second one claims.
    doit.readDelayMs = 150;
    const now = pollTime();

    const [first, second] = await Promise.all([
      pollPendingGatewayIntents(tenantContext(), now, 100),
      pollPendingGatewayIntents(tenantContext(), now, 100),
    ]);

    for (const intent of intents)
      expect(doit.readsOf(intent.providerRef)).toBe(1);
    expect(first.checked + second.checked).toBe(intents.length);
    expect(doit.totalReads()).toBe(intents.length);
    expect(first.settled + second.settled).toBe(0);
    for (const intent of intents)
      expect((await intentRow(intent.id)).status).toBe("pending");
  });

  it("splits the work between two concurrent runs when each has a small limit", async () => {
    const intents = await pendingIntents(4);
    doit.readDelayMs = 150;
    const now = pollTime();

    const [first, second] = await Promise.all([
      pollPendingGatewayIntents(tenantContext(), now, 2),
      pollPendingGatewayIntents(tenantContext(), now, 2),
    ]);

    // Each run took its own two: nothing asked twice, nothing left out.
    expect(first.checked).toBe(2);
    expect(second.checked).toBe(2);
    for (const intent of intents)
      expect(doit.readsOf(intent.providerRef)).toBe(1);
  });

  it("releases every lease after a run", async () => {
    const intents = await pendingIntents(3);

    const result = await pollPendingGatewayIntents(
      tenantContext(),
      pollTime(),
      100,
    );

    expect(result.checked).toBe(intents.length);
    await expectAllLeasesReleased(intents);
  });

  it("does not free a lease another worker took over while this run was slow", async () => {
    const [intent] = await pendingIntents(1);
    doit.readDelayMs = 400;

    const run = pollPendingGatewayIntents(tenantContext(), pollTime(), 100);
    // Wait until the run is inside its gateway call, then let "another worker"
    // take the lease over (as if ours had lapsed).
    for (let i = 0; i < 100 && doit.readsOf(intent!.providerRef) === 0; i += 1)
      await new Promise((accept) => setTimeout(accept, 20));
    expect(doit.readsOf(intent!.providerRef)).toBe(1);
    const takenOver = new Date(Date.now() + 90 * 60_000);
    await setLease(intent!.id, takenOver);
    await run;

    expect((await intentRow(intent!.id)).lease?.getTime()).toBe(
      takenOver.getTime(),
    );
  });

  it.each<[string, FailMode]>([
    ["DOIT answers HTTP 500", "http500"],
    ["DOIT drops the connection", "drop"],
  ])("releases every lease when %s", async (_label, mode) => {
    const intents = await pendingIntents(4);
    doit.failMode = mode;

    // The run may stop early after repeated gateway errors; leases of rows it
    // never reached must still be freed.
    await pollPendingGatewayIntents(tenantContext(), pollTime(), 100);

    expect(doit.totalReads()).toBeGreaterThan(0);
    await expectAllLeasesReleased(intents);
    for (const intent of intents)
      expect((await intentRow(intent.id)).status).toBe("pending");
  });

  it("skips an intent whose lease is still in the future", async () => {
    const [held, free] = await pendingIntents(2);
    await setLease(held!.id, new Date(Date.now() + 60 * 60_000));

    const result = await pollPendingGatewayIntents(
      tenantContext(),
      pollTime(),
      100,
    );

    expect(result.checked).toBe(1);
    expect(doit.readsOf(held!.providerRef)).toBe(0);
    expect(doit.readsOf(free!.providerRef)).toBe(1);
    // The other worker's lease is not ours to clear.
    expect((await intentRow(held!.id)).lease).not.toBeNull();
    expect((await intentRow(free!.id)).lease).toBeNull();
  });

  it("takes an intent again once its lease has elapsed (dead worker)", async () => {
    const [stale] = await pendingIntents(1);
    // Claimed long ago by a worker that died before releasing.
    await setLease(stale!.id, new Date(Date.now() - 10 * 60_000));

    const result = await pollPendingGatewayIntents(
      tenantContext(),
      pollTime(),
      100,
    );

    expect(result.checked).toBe(1);
    expect(doit.readsOf(stale!.providerRef)).toBe(1);
    expect((await intentRow(stale!.id)).lease).toBeNull();
  });

  it("honours the limit", async () => {
    const intents = await pendingIntents(4);

    const result = await pollPendingGatewayIntents(
      tenantContext(),
      pollTime(),
      2,
    );

    expect(result.checked).toBe(2);
    expect(doit.totalReads()).toBe(2);
    const asked = intents.filter((i) => doit.readsOf(i.providerRef) === 1);
    expect(asked).toHaveLength(2);
    // Unclaimed intents never got a lease; claimed ones released it.
    await expectAllLeasesReleased(intents);
  });

  it("asks about nothing when every intent is leased by another worker", async () => {
    const intents = await pendingIntents(2);
    for (const intent of intents)
      await setLease(intent.id, new Date(Date.now() + 60 * 60_000));

    const result = await pollPendingGatewayIntents(
      tenantContext(),
      pollTime(),
      100,
    );

    expect(result).toEqual({ checked: 0, settled: 0 });
    expect(doit.totalReads()).toBe(0);
  });
});
