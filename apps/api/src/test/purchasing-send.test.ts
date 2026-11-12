// Send a purchase order (PRD v1.7 §3.18 "Kirim PO"; bead legend-9yz, slice E).
// Needs the disposable PostgreSQL database. Orders are seeded by direct inserts
// (the order service is a parallel slice). The routers are mounted on the
// shared apiRouter here so the suite does not depend on routes/index.ts wiring.
//
// Acceptance ids used in test names:
// - 9yz-SEND-1 share link (URL, hash-only storage, public PDF)
// - 9yz-SEND-2 wrong, expired, revoked and malformed tokens are one 404
// - 9yz-SEND-3 email queue, sent PO, worker job, no address in logs
// - 9yz-SEND-4 only approved (or already sent) orders can be sent
// - 9yz-ISO-3 tenant isolation of send and of the public link
// - 25a7-PO-2 emailDeliveryStatus on the order DTO (detail and list)
// - 25a7-SEND-1 send refusals carry their own purchasing codes
// - 50-F1 default recipient, recipient permission, resend limit
// - 50-F2 revoke share links
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import { FakeEmailProvider } from "@starter/shared/adapters";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createLogger } from "../lib/logger.ts";
import { apiRouter } from "../routes/index.ts";
import {
  createPurchasingSendRouter,
  publicPurchaseOrderRouter,
} from "../routes/purchasing-send.routes.ts";
import {
  getPurchaseOrder,
  listPurchaseOrders,
  transitionPurchaseOrderStatus,
} from "../services/purchasing-order.service.ts";
import { revokePurchaseOrderShareLinks } from "../services/purchasing-send.service.ts";
import { runPurchasingPoEmailJob } from "../worker/purchasing-po-email.job.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { allText } from "./pdf-text.ts";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  seededHostname,
  staffOfIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

// Registered once, before the app serves a request; the lead's real mount in
// routes/index.ts is the same two lines.
apiRouter.use("/inventory", createPurchasingSendRouter());
apiRouter.use("/public/purchase-orders", publicPurchaseOrderRouter);

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});

const logLines: string[] = [];
const logStream = new Writable({
  write(chunk, _encoding, done) {
    logLines.push(String(chunk));
    done();
  },
});

let app: Express;
let tenantB: IsolatedTenant;
let sender: { client: ReturnType<typeof agent>; userId: string };
let outsider: { client: ReturnType<typeof agent>; userId: string };
let staffB: { client: ReturnType<typeof agent>; userId: string };
let approverId: string;
let uomId: string;
let itemId: string;
let supplierId: string;
let narrow: { client: ReturnType<typeof agent>; userId: string };
let narrowRoleId: string;
const extraSupplierIds: string[] = [];
const createdUserIds: string[] = [];
const orderIds: string[] = [];

const tenantContext = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantA,
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );

async function asTenant<T>(
  tenantId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    return await run(client as unknown as Client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function signedIn(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  return { client, userId };
}

async function grantTemplate(userId: string, templateKey: string) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantA, templateKey],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantA, userId, rows[0]!.id],
  );
}

/** A priced order: 2.5 x 10.000 + 3 x 4.000 = Rp 37.000, no tax. */
async function seedOrder(
  status: string,
  forSupplierId = supplierId,
): Promise<{ id: string; number: string }> {
  const id = randomUUID();
  const number = `PO/209912/${randomBytes(4).toString("hex")}`;
  const approved = !["draft", "pending_approval", "cancelled"].includes(status);
  const sent = ["sent", "partially_received", "received", "closed"].includes(
    status,
  );
  await owner.query(
    `INSERT INTO purchase_orders
       (id, tenant_id, outlet_id, supplier_id, number, status, expected_date,
        subtotal_idr, tax_idr, total_idr, source, created_by, approved_by,
        approved_at, sent_at, closed_at)
     VALUES ($1, $2, $3, $4, $5, $6, '2099-12-20', 37000, 0, 37000, 'user',
        $7, $8, $9, $10, $11)`,
    [
      id,
      tenantA,
      outletA,
      forSupplierId,
      number,
      status,
      sender.userId,
      approved ? approverId : null,
      approved ? new Date() : null,
      sent ? new Date() : null,
      status === "closed" ? new Date() : null,
    ],
  );
  const lines: [string, string, number][] = [
    ["2.5000", "10000.0000", 25000],
    ["3.0000", "4000.0000", 12000],
  ];
  for (const [index, [quantity, price, total]] of lines.entries())
    await owner.query(
      `INSERT INTO purchase_order_lines
         (tenant_id, outlet_id, purchase_order_id, inventory_item_id, quantity,
          uom_id, unit_price_idr, line_total_idr, line_no)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tenantA, outletA, id, itemId, quantity, uomId, price, total, index + 1],
    );
  orderIds.push(id);
  return { id, number };
}

/** A supplier with an optional own email and optional contacts. */
async function seedSupplier(
  email: string | null,
  contacts: { email: string | null; isPrimary: boolean }[] = [],
): Promise<string> {
  const id = (
    await owner.query<{ id: string }>(
      `INSERT INTO suppliers (tenant_id, name, email, payment_terms_days, created_by)
       VALUES ($1, $2, $3, 14, $4) RETURNING id`,
      [
        tenantA,
        `Pemasok Alamat ${randomBytes(4).toString("hex")}`,
        email,
        sender.userId,
      ],
    )
  ).rows[0]!.id;
  extraSupplierIds.push(id);
  for (const contact of contacts)
    await owner.query(
      `INSERT INTO supplier_contacts (tenant_id, supplier_id, name, phone, email, is_primary)
       VALUES ($1, $2, 'Kontak', '+628111111111', $3, $4)`,
      [tenantA, id, contact.email, contact.isPrimary],
    );
  return id;
}

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function send(
  client: ReturnType<typeof agent>,
  orderId: string,
  body: Record<string, unknown>,
  host = seededHostname,
) {
  return client
    .post(`/api/inventory/purchase-orders/${orderId}/send`)
    .set(originHeader)
    .set("Host", host)
    .send({ idempotencyKey: `send-${randomUUID()}`, ...body });
}

function publicGet(path: string, host = seededHostname) {
  return agent(app)
    .get(path)
    .set("Host", host)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });
}

const pathOf = (url: string) => new URL(url).pathname;
const tokenOf = (url: string) => pathOf(url).split("/").pop()!;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp({
    logger: createLogger({ level: "debug", destination: logStream }),
  });
  sender = await signedIn("PO Sender");
  await grantTemplate(sender.userId, "purchasing");
  outsider = await signedIn("PO Outsider");
  // Holds the send permission only: no supplier management.
  narrowRoleId = randomUUID();
  narrow = await signedIn("PO Narrow Sender");
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, '["purchasing.order.create"]', '["tenant"]')`,
    [narrowRoleId, tenantA, `Narrow Sender ${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantA, narrow.userId, narrowRoleId],
  );
  approverId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [approverId, "PO Approver", `${approverId}@example.com`],
  );
  uomId = (
    await owner.query<{ id: string }>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, 'Kilogram Kirim') RETURNING id",
      [tenantA, `k${randomBytes(3).toString("hex")}`],
    )
  ).rows[0]!.id;
  itemId = (
    await owner.query<{ id: string }>(
      "INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id) VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3) RETURNING id",
      [tenantA, `Gula Kirim ${randomBytes(3).toString("hex")}`, uomId],
    )
  ).rows[0]!.id;
  supplierId = (
    await owner.query<{ id: string }>(
      `INSERT INTO suppliers (tenant_id, name, address, phone, payment_terms_days, created_by)
       VALUES ($1, $2, 'Jl. Pemasok 9', '+628123456789', 14, $3) RETURNING id`,
      [
        tenantA,
        `Pemasok Kirim ${randomBytes(3).toString("hex")}`,
        sender.userId,
      ],
    )
  ).rows[0]!.id;

  tenantB = await createIsolatedTenant(`po-${randomUUID().slice(0, 6)}`);
  // The isolated role only holds floor permissions: add the PO send one, so
  // tenant B's 404 comes from isolation and not from a missing permission.
  await owner.query(
    "UPDATE roles SET permissions = permissions || '[\"purchasing.order.create\"]'::jsonb WHERE id = $1",
    [tenantB.roleId],
  );
  const staff = await staffOfIsolatedTenant(app, tenantB);
  staffB = { client: staff.client, userId: staff.userId };
  createdUserIds.push(staff.userId);
});

afterAll(async () => {
  const ids = orderIds;
  await owner.query(
    "DELETE FROM purchase_order_email_deliveries WHERE purchase_order_id = ANY($1::uuid[])",
    [ids],
  );
  await owner.query(
    "DELETE FROM purchase_order_share_links WHERE purchase_order_id = ANY($1::uuid[])",
    [ids],
  );
  await owner.query(
    "DELETE FROM purchasing_idempotency WHERE tenant_id = $1 AND operation LIKE 'purchase_order.%'",
    [tenantA],
  );
  await owner.query(
    "DELETE FROM purchase_order_lines WHERE purchase_order_id = ANY($1::uuid[])",
    [ids],
  );
  await owner.query("DELETE FROM purchase_orders WHERE id = ANY($1::uuid[])", [
    ids,
  ]);
  await owner.query(
    "DELETE FROM supplier_contacts WHERE supplier_id = ANY($1::uuid[])",
    [extraSupplierIds],
  );
  await owner.query("DELETE FROM suppliers WHERE id = ANY($1::uuid[])", [
    [supplierId, ...extraSupplierIds],
  ]);
  await owner.query("DELETE FROM inventory_items WHERE id = $1", [itemId]);
  await owner.query("DELETE FROM uoms WHERE id = $1", [uomId]);
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantA, createdUserIds],
  );
  await owner.query("DELETE FROM roles WHERE id = $1", [narrowRoleId]);
  await dropIsolatedTenant(tenantB);
  await owner.end();
  await appPool.end();
});

describe("9yz-SEND-1 share link", () => {
  it("[9yz-SEND-1] returns URL and expiry, stores only the hash, serves the PDF", async () => {
    const order = await seedOrder("approved");
    const key = `send-${randomUUID()}`;
    const response = await send(sender.client, order.id, {
      channel: "share_link",
      idempotencyKey: key,
    });
    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data).toMatchObject({
      channel: "share_link",
      sentTo: null,
      purchaseOrder: { id: order.id, status: "sent", sentTo: null },
    });
    expect(data.purchaseOrder.sentAt).toEqual(expect.any(String));
    expect(pathOf(data.shareUrl)).toMatch(
      /^\/api\/public\/purchase-orders\/[A-Za-z0-9_-]{43}$/,
    );
    // Built on the tenant's verified host so a cookieless click resolves it.
    const linkHost = new URL(data.shareUrl).host;
    expect(
      cafeLegendPlatformFixtures.domains.map((domain) => domain.hostname),
    ).toContain(linkHost);
    const ttl = Date.parse(data.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(6.9 * 86_400_000);
    expect(ttl).toBeLessThanOrEqual(7 * 86_400_000);

    const token = tokenOf(data.shareUrl);
    const { rows: links } = await owner.query(
      "SELECT token_hash FROM purchase_order_share_links WHERE purchase_order_id = $1",
      [order.id],
    );
    expect(links).toEqual([{ token_hash: sha256(token) }]);
    // No table keeps the raw token, idempotency replay included.
    const { rows: stored } = await owner.query<{ hit: boolean }>(
      "SELECT response::text LIKE $2 AS hit FROM purchasing_idempotency WHERE tenant_id = $1 AND idempotency_key = $3",
      [tenantA, `%${token}%`, key],
    );
    expect(stored).toEqual([{ hit: false }]);

    const pdf = await publicGet(pathOf(data.shareUrl), linkHost);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.headers["cache-control"]).toContain("no-store");
    const text = (pdf.body as Buffer).toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    const drawn = allText(pdf.body as Buffer);
    expect(drawn).toContain(order.number);
    expect(drawn).toContain("Rp 37.000");
  });

  it("[9yz-SEND-1] replays the same key to the same link and issues a new one per key", async () => {
    const order = await seedOrder("approved");
    const body = {
      channel: "share_link",
      idempotencyKey: `send-${randomUUID()}`,
    };
    const first = await send(sender.client, order.id, body);
    const replay = await send(sender.client, order.id, body);
    expect(replay.status).toBe(200);
    expect(replay.body.data.shareUrl).toBe(first.body.data.shareUrl);
    expect(replay.body.data.expiresAt).toBe(first.body.data.expiresAt);
    // A resend (already sent) is a new link and changes no state.
    const resend = await send(sender.client, order.id, {
      channel: "share_link",
    });
    expect(resend.status).toBe(200);
    expect(resend.body.data.shareUrl).not.toBe(first.body.data.shareUrl);
    expect(resend.body.data.purchaseOrder.sentAt).toBe(
      first.body.data.purchaseOrder.sentAt,
    );
    // The same key for a different request is refused.
    const reused = await send(sender.client, order.id, {
      channel: "email",
      email: "x@supplier-test.example",
      idempotencyKey: body.idempotencyKey,
    });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("[9yz-SEND-1] [25a7-SEND-1] a replay whose link expired, was revoked or was removed is a 409, not a dead URL", async () => {
    const order = await seedOrder("approved");
    const body = {
      channel: "share_link",
      idempotencyKey: `send-${randomUUID()}`,
    };
    await send(sender.client, order.id, body);
    const replay = () => send(sender.client, order.id, body);
    expect((await replay()).status).toBe(200);
    for (const change of [
      "expires_at = now() - interval '1 second'",
      "expires_at = now() + interval '1 day', revoked_at = now()",
    ]) {
      await owner.query(
        `UPDATE purchase_order_share_links SET ${change} WHERE purchase_order_id = $1`,
        [order.id],
      );
      const response = await replay();
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(
        "PURCHASE_ORDER_SHARE_LINK_UNAVAILABLE",
      );
    }
    await owner.query(
      "DELETE FROM purchase_order_share_links WHERE purchase_order_id = $1",
      [order.id],
    );
    const gone = await replay();
    expect(gone.status).toBe(409);
    expect(gone.body.error.code).toBe("PURCHASE_ORDER_SHARE_LINK_UNAVAILABLE");
  });

  it("[9yz-SEND-1] refuses a caller without the send permission", async () => {
    const order = await seedOrder("approved");
    const response = await send(outsider.client, order.id, {
      channel: "share_link",
    });
    expect(response.status).toBe(403);
    const { rows } = await owner.query(
      "SELECT status FROM purchase_orders WHERE id = $1",
      [order.id],
    );
    expect(rows[0].status).toBe("approved");
  });
});

describe("9yz-SEND-2 token checks", () => {
  it("[9yz-SEND-2] wrong, malformed, expired and revoked tokens answer the same 404", async () => {
    const order = await seedOrder("approved");
    const issued = await send(sender.client, order.id, {
      channel: "share_link",
    });
    const path = pathOf(issued.body.data.shareUrl);
    expect((await publicGet(path)).status).toBe(200);

    const wrong = await publicGet(
      `/api/public/purchase-orders/${randomBytes(32).toString("base64url")}`,
    );
    const malformed = await publicGet("/api/public/purchase-orders/short");
    await owner.query(
      "UPDATE purchase_order_share_links SET expires_at = now() - interval '1 second' WHERE purchase_order_id = $1",
      [order.id],
    );
    const expired = await publicGet(path);
    await owner.query(
      "UPDATE purchase_order_share_links SET expires_at = now() + interval '1 day', revoked_at = now() WHERE purchase_order_id = $1",
      [order.id],
    );
    const revoked = await publicGet(path);

    const shape = (res: { status: number; body: unknown }) => {
      const parsed = JSON.parse((res.body as Buffer).toString("utf8")) as {
        error: { code: string; message: string };
      };
      return [res.status, parsed.error.code, parsed.error.message];
    };
    expect(shape(wrong)).toEqual([
      404,
      "NOT_FOUND",
      "Dokumen tidak ditemukan.",
    ]);
    for (const other of [malformed, expired, revoked])
      expect(shape(other)).toEqual(shape(wrong));
  });

  it("[9yz-SEND-2] never writes the token into the access log", async () => {
    const order = await seedOrder("approved");
    const issued = await send(sender.client, order.id, {
      channel: "share_link",
    });
    const token = tokenOf(issued.body.data.shareUrl);
    await publicGet(pathOf(issued.body.data.shareUrl));
    expect(logLines.join("")).toContain(
      "/api/public/purchase-orders/[redacted]",
    );
    expect(logLines.join("")).not.toContain(token);
  });
});

describe("9yz-SEND-3 email", () => {
  it("[9yz-SEND-3] queues the delivery, sends the PO, and the job marks it sent", async () => {
    const order = await seedOrder("approved");
    const address = `buyer-${randomBytes(4).toString("hex")}@supplier-test.example`;
    const response = await send(sender.client, order.id, {
      channel: "email",
      email: address,
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      channel: "email",
      sentTo: address,
      shareUrl: null,
      expiresAt: null,
      purchaseOrder: { status: "sent", sentTo: address },
    });
    const { rows: queued } = await owner.query(
      "SELECT status, attempts FROM purchase_order_email_deliveries WHERE purchase_order_id = $1",
      [order.id],
    );
    expect(queued).toEqual([{ status: "queued", attempts: 0 }]);

    const fake = new FakeEmailProvider();
    const spies = (["log", "info", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const result = await runPurchasingPoEmailJob([tenantContext()], {
      email: fake,
    });
    const consoleOutput = spies
      .flatMap((spy) => spy.mock.calls)
      .map((call) => JSON.stringify(call))
      .join("\n");
    spies.forEach((spy) => spy.mockRestore());
    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    const mail = fake.sent.find((item) => item.to === address)!;
    expect(mail).toBeDefined();
    expect(mail.subject).toContain(order.number);
    const link =
      /https?:\/\/\S+\/api\/public\/purchase-orders\/[A-Za-z0-9_-]+/.exec(
        mail.body,
      )![0];
    const { rows: done } = await owner.query(
      "SELECT status, attempts, sent_at, last_error FROM purchase_order_email_deliveries WHERE purchase_order_id = $1",
      [order.id],
    );
    expect(done[0]).toMatchObject({
      status: "sent",
      attempts: 1,
      last_error: null,
    });
    expect(done[0].sent_at).not.toBeNull();
    // The link in the email serves the PDF.
    const pdf = await publicGet(pathOf(link));
    expect(pdf.status).toBe(200);
    expect(allText(pdf.body as Buffer)).toContain(order.number);

    expect(logLines.join("")).not.toContain(address);
    expect(consoleOutput).not.toContain(address);
    // Replaying the job sends nothing twice.
    await runPurchasingPoEmailJob([tenantContext()], { email: fake });
    expect(fake.sent.filter((item) => item.to === address)).toHaveLength(1);
  });

  it("[9yz-SEND-3] without a provider leaves the delivery queued and untouched", async () => {
    const order = await seedOrder("approved");
    const address = `closed-${randomBytes(4).toString("hex")}@supplier-test.example`;
    await send(sender.client, order.id, { channel: "email", email: address });
    const result = await runPurchasingPoEmailJob([tenantContext()], {
      email: null,
    });
    expect(result).toEqual({ sent: 0, retried: 0, failed: 0 });
    const { rows } = await owner.query(
      "SELECT status, attempts, last_error, next_attempt_at FROM purchase_order_email_deliveries WHERE purchase_order_id = $1",
      [order.id],
    );
    expect(rows).toEqual([
      {
        status: "queued",
        attempts: 0,
        last_error: null,
        next_attempt_at: null,
      },
    ]);
    // Once a provider exists the same row goes out.
    const fake = new FakeEmailProvider();
    await runPurchasingPoEmailJob([tenantContext()], { email: fake });
    expect(fake.sent.some((item) => item.to === address)).toBe(true);
  });

  it("[9yz-SEND-3] backs off a provider failure and never stores the address in the reason", async () => {
    const order = await seedOrder("approved");
    const address = `flaky-${randomBytes(4).toString("hex")}@supplier-test.example`;
    await send(sender.client, order.id, { channel: "email", email: address });
    const failing = {
      send: async () => {
        throw new Error(`smtp rejected ${address}`);
      },
    };
    const row = async () =>
      (
        await owner.query<{
          status: string;
          attempts: number;
          last_error: string;
          next_attempt_at: Date | null;
        }>(
          "SELECT status, attempts, last_error, next_attempt_at FROM purchase_order_email_deliveries WHERE purchase_order_id = $1",
          [order.id],
        )
      ).rows[0]!;
    // Waits after failed attempts 1..5: 1 min, 5 min, 30 min, 2 h, 6 h.
    const waits = [60, 300, 1800, 7200, 21600];
    let now = new Date();
    for (const [index, wait] of waits.entries()) {
      await runPurchasingPoEmailJob([tenantContext()], { email: failing }, now);
      const state = await row();
      expect(state).toMatchObject({ status: "queued", attempts: index + 1 });
      expect(state.last_error).not.toContain(address);
      expect(state.next_attempt_at!.getTime()).toBe(
        now.getTime() + wait * 1000,
      );
      // Still waiting: the same instant claims nothing.
      await runPurchasingPoEmailJob([tenantContext()], { email: failing }, now);
      expect((await row()).attempts).toBe(index + 1);
      now = new Date(now.getTime() + wait * 1000);
    }
    // The sixth failure is final.
    await runPurchasingPoEmailJob([tenantContext()], { email: failing }, now);
    expect(await row()).toMatchObject({
      status: "failed",
      attempts: 6,
      next_attempt_at: null,
    });
  });
});

describe("9yz-SEND-4 status gate", () => {
  it.each(["draft", "pending_approval", "cancelled", "closed"])(
    "[9yz-SEND-4] [25a7-SEND-1] refuses to send a %s order",
    async (status) => {
      const order = await seedOrder(status);
      for (const body of [
        { channel: "share_link" },
        { channel: "email", email: "gate@supplier-test.example" },
      ]) {
        const response = await send(sender.client, order.id, body);
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe("PURCHASE_ORDER_NOT_SENDABLE");
      }
      const { rows } = await owner.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM purchase_order_share_links WHERE purchase_order_id = $1)
              + (SELECT count(*) FROM purchase_order_email_deliveries WHERE purchase_order_id = $1) AS n`,
        [order.id],
      );
      expect(Number(rows[0]!.n)).toBe(0);
    },
  );

  it("[9yz-SEND-4] requires an email for the email channel", async () => {
    const order = await seedOrder("approved");
    const response = await send(sender.client, order.id, { channel: "email" });
    expect(response.status).toBe(422);
  });
});

describe("25a7-PO-2 emailDeliveryStatus", () => {
  it("[25a7-PO-2] is null before a send, then queued, sent and failed, in detail and in the list", async () => {
    const status = async (id: string) => {
      const detail = await getPurchaseOrder(tenantContext(), sender.userId, id);
      const list = await listPurchaseOrders(tenantContext(), sender.userId, {
        outletId: outletA,
        supplierId,
        limit: 100,
      } as never);
      const listed = list.data.find((item) => item.id === id)!;
      expect(listed.emailDeliveryStatus).toBe(
        detail.purchaseOrder.emailDeliveryStatus,
      );
      return detail.purchaseOrder.emailDeliveryStatus;
    };
    const address = `status-${randomBytes(4).toString("hex")}@supplier-test.example`;

    const delivered = await seedOrder("approved");
    expect(await status(delivered.id)).toBeNull();
    const sentResponse = await send(sender.client, delivered.id, {
      channel: "email",
      email: address,
    });
    expect(sentResponse.body.data.purchaseOrder.emailDeliveryStatus).toBe(
      "queued",
    );
    expect(await status(delivered.id)).toBe("queued");
    await runPurchasingPoEmailJob([tenantContext()], {
      email: new FakeEmailProvider(),
    });
    expect(await status(delivered.id)).toBe("sent");

    const broken = await seedOrder("approved");
    await send(sender.client, broken.id, { channel: "email", email: address });
    expect(await status(broken.id)).toBe("queued");
    const failing = {
      send: async () => {
        throw new Error("smtp down");
      },
    };
    // Six failures are final; each step waits past the longest backoff.
    let now = new Date();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await runPurchasingPoEmailJob([tenantContext()], { email: failing }, now);
      now = new Date(now.getTime() + 22000 * 1000);
    }
    expect(await status(broken.id)).toBe("failed");

    // A share link is no email: status stays null.
    const shared = await seedOrder("approved");
    await send(sender.client, shared.id, { channel: "share_link" });
    expect(await status(shared.id)).toBeNull();
  });
});

describe("25a7-PO-3 updatedAt", () => {
  it("[25a7-PO-3] updatedAt strictly increases after a send", async () => {
    const stamp = async (id: string) => {
      const { rows } = await owner.query<{ updated_at: Date }>(
        "SELECT updated_at FROM purchase_orders WHERE id = $1",
        [id],
      );
      return rows[0]!.updated_at.getTime();
    };
    const order = await seedOrder("approved");
    const before = await stamp(order.id);
    const response = await send(sender.client, order.id, {
      channel: "share_link",
    });
    expect(response.status).toBe(200);
    expect(await stamp(order.id)).toBeGreaterThan(before);
  });
});

describe("9yz-ISO-3 isolation", () => {
  it("[9yz-ISO-3] tenant B cannot send tenant A's order", async () => {
    const order = await seedOrder("approved");
    const response = await send(
      staffB.client,
      order.id,
      { channel: "share_link" },
      tenantB.hostname,
    );
    expect(response.status).toBe(404);
    const { rows } = await owner.query(
      "SELECT status FROM purchase_orders WHERE id = $1",
      [order.id],
    );
    expect(rows[0].status).toBe("approved");
  });

  it("[9yz-ISO-3] a tenant A token is nothing on tenant B's host, and RLS hides the link", async () => {
    const order = await seedOrder("approved");
    const issued = await send(sender.client, order.id, {
      channel: "share_link",
    });
    const path = pathOf(issued.body.data.shareUrl);
    expect((await publicGet(path)).status).toBe(200);
    const foreign = await publicGet(path, tenantB.hostname);
    expect(foreign.status).toBe(404);
    expect((foreign.body as Buffer).toString("utf8")).not.toContain(
      order.number,
    );
    const rows = await asTenant(tenantB.tenantId, async (client) => {
      const { rows } = await client.query(
        "SELECT id FROM purchase_order_share_links WHERE purchase_order_id = $1",
        [order.id],
      );
      return rows;
    });
    expect(rows).toHaveLength(0);
    const pdf = await publicGet(path);
    const text = allText(pdf.body as Buffer);
    expect(text).toContain("PO/");
    expect(text).not.toContain(`Tenant ${tenantB.hostname}`);
  });
});

describe("50-F1 recipient and resend limit", () => {
  const emailRows = (orderId: string) =>
    owner
      .query<{ recipient_email: string }>(
        "SELECT recipient_email FROM purchase_order_email_deliveries WHERE purchase_order_id = $1",
        [orderId],
      )
      .then((result) => result.rows.map((row) => row.recipient_email));

  it("[50-F1] an email send without an address goes to the supplier email", async () => {
    const supplier = await seedSupplier("Orders@Supplier-Default.example");
    const order = await seedOrder("approved", supplier);
    const response = await send(sender.client, order.id, { channel: "email" });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      channel: "email",
      sentTo: "Orders@Supplier-Default.example",
      purchaseOrder: { status: "sent" },
    });
    expect(await emailRows(order.id)).toEqual([
      "Orders@Supplier-Default.example",
    ]);
  });

  it("[50-F1] without a supplier email it uses the primary contact, else 422", async () => {
    const withContact = await seedSupplier(null, [
      { email: "second@supplier-default.example", isPrimary: false },
      { email: "primary@supplier-default.example", isPrimary: true },
    ]);
    const order = await seedOrder("approved", withContact);
    const response = await send(sender.client, order.id, { channel: "email" });
    expect(response.status).toBe(200);
    expect(await emailRows(order.id)).toEqual([
      "primary@supplier-default.example",
    ]);

    const bare = await seedSupplier(null, [{ email: null, isPrimary: true }]);
    const bareOrder = await seedOrder("approved", bare);
    const refused = await send(sender.client, bareOrder.id, {
      channel: "email",
    });
    expect(refused.status).toBe(422);
    const { rows } = await owner.query(
      "SELECT status FROM purchase_orders WHERE id = $1",
      [bareOrder.id],
    );
    expect(rows[0].status).toBe("approved");
  });

  it("[50-F1] another address needs purchasing.supplier.manage; the supplier's own addresses do not", async () => {
    const supplier = await seedSupplier("own@supplier-default.example", [
      { email: "Contact@Supplier-Default.example", isPrimary: true },
    ]);
    const order = await seedOrder("approved", supplier);
    const foreign = await send(narrow.client, order.id, {
      channel: "email",
      email: "stranger@elsewhere.example",
    });
    expect(foreign.status).toBe(403);
    const { rows } = await owner.query(
      "SELECT status FROM purchase_orders WHERE id = $1",
      [order.id],
    );
    expect(rows[0].status).toBe("approved");
    expect(await emailRows(order.id)).toEqual([]);

    // Case-insensitive match on the supplier email and on a contact email.
    for (const address of [
      "OWN@supplier-default.example",
      "contact@supplier-default.example",
    ]) {
      const ok = await send(narrow.client, order.id, {
        channel: "email",
        email: address,
      });
      expect(ok.status).toBe(200);
    }
    // A buyer who manages suppliers may use any address.
    const managed = await send(sender.client, order.id, {
      channel: "email",
      email: "stranger@elsewhere.example",
    });
    expect(managed.status).toBe(200);
  });

  it("[50-F1] the sixth send of one PO in an hour is a 429; a replay is not counted", async () => {
    const order = await seedOrder("approved");
    const first = {
      channel: "share_link",
      idempotencyKey: `send-${randomUUID()}`,
    };
    for (let index = 0; index < 5; index += 1) {
      const body =
        index === 0
          ? first
          : { channel: "email", email: `limit-${index}@supplier-test.example` };
      expect((await send(sender.client, order.id, body)).status).toBe(200);
    }
    const sixth = await send(sender.client, order.id, {
      channel: "email",
      email: "limit-6@supplier-test.example",
    });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe("RATE_LIMITED");
    // Replaying an accepted send still answers from the stored response.
    expect((await send(sender.client, order.id, first)).status).toBe(200);
    // Another PO has its own budget.
    const other = await seedOrder("approved");
    expect(
      (await send(sender.client, other.id, { channel: "share_link" })).status,
    ).toBe(200);
    // Sends older than an hour no longer count.
    await owner.query(
      "UPDATE purchase_order_email_deliveries SET created_at = now() - interval '2 hours' WHERE purchase_order_id = $1",
      [order.id],
    );
    const later = await send(sender.client, order.id, {
      channel: "email",
      email: "limit-7@supplier-test.example",
    });
    expect(later.status).toBe(200);
  });
});

describe("50-F2 revoke share links", () => {
  const revoke = (
    client: ReturnType<typeof agent>,
    orderId: string,
    body: Record<string, unknown> = {},
    host = seededHostname,
  ) =>
    client
      .post(`/api/inventory/purchase-orders/${orderId}/share-links/revoke`)
      .set(originHeader)
      .set("Host", host)
      .send({ idempotencyKey: `revoke-${randomUUID()}`, ...body });

  it("[50-F2] revokes every live link, the public URL turns 404, a replay answers the same", async () => {
    const order = await seedOrder("approved");
    const one = await send(sender.client, order.id, { channel: "share_link" });
    const two = await send(sender.client, order.id, { channel: "share_link" });
    const urls = [one, two].map((r) => pathOf(r.body.data.shareUrl as string));
    for (const url of urls) expect((await publicGet(url)).status).toBe(200);

    const key = `revoke-${randomUUID()}`;
    const response = await revoke(sender.client, order.id, {
      idempotencyKey: key,
      note: "Wrong supplier",
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ revoked: 2 });
    for (const url of urls) expect((await publicGet(url)).status).toBe(404);
    const { rows } = await owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM purchase_order_share_links WHERE purchase_order_id = $1 AND revoked_at IS NULL",
      [order.id],
    );
    expect(Number(rows[0]!.n)).toBe(0);

    const replay = await revoke(sender.client, order.id, {
      idempotencyKey: key,
      note: "Wrong supplier",
    });
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual({ revoked: 2 });
    // Nothing live is left: a new key revokes zero.
    const again = await revoke(sender.client, order.id);
    expect(again.body.data).toEqual({ revoked: 0 });
    // The same key for different input is refused.
    const reused = await revoke(sender.client, order.id, {
      idempotencyKey: key,
      note: "Other",
    });
    expect(reused.status).toBe(409);
  });

  it("[50-F2] needs the order permission, and tenant B cannot reach tenant A's order", async () => {
    const order = await seedOrder("approved");
    await send(sender.client, order.id, { channel: "share_link" });
    expect((await revoke(outsider.client, order.id)).status).toBe(403);
    const crossTenant = await revoke(
      staffB.client,
      order.id,
      {},
      tenantB.hostname,
    );
    expect(crossTenant.status).toBe(404);
    const { rows } = await owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM purchase_order_share_links WHERE purchase_order_id = $1 AND revoked_at IS NULL",
      [order.id],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it("[50-F2] revokePurchaseOrderShareLinks revokes live links only and returns the count", async () => {
    const order = await seedOrder("approved");
    await send(sender.client, order.id, { channel: "share_link" });
    await send(sender.client, order.id, { channel: "share_link" });
    await owner.query(
      `UPDATE purchase_order_share_links SET revoked_at = now()
        WHERE id = (SELECT id FROM purchase_order_share_links WHERE purchase_order_id = $1 LIMIT 1)`,
      [order.id],
    );
    const count = await withTenant(db, tenantContext(), (tx) =>
      revokePurchaseOrderShareLinks(tx, tenantContext(), order.id),
    );
    expect(count).toBe(1);
  });
});

describe("proc-fix PO email stops after revoke, close, cancel", () => {
  const revoke = (orderId: string) =>
    sender.client
      .post(`/api/inventory/purchase-orders/${orderId}/share-links/revoke`)
      .set(originHeader)
      .set("Host", seededHostname)
      .send({ idempotencyKey: `revoke-${randomUUID()}` });

  const transition = (orderId: string, action: "close" | "cancel") =>
    transitionPurchaseOrderStatus(tenantContext(), sender.userId, orderId, {
      action,
      idempotencyKey: `tr-${randomUUID()}`,
    });

  const deliveryOf = async (orderId: string) =>
    (
      await owner.query<{
        status: string;
        attempts: number;
        last_error: string | null;
      }>(
        "SELECT status, attempts, last_error FROM purchase_order_email_deliveries WHERE purchase_order_id = $1",
        [orderId],
      )
    ).rows[0]!;

  const linkCount = async (orderId: string) =>
    Number(
      (
        await owner.query<{ n: string }>(
          "SELECT count(*) AS n FROM purchase_order_share_links WHERE purchase_order_id = $1",
          [orderId],
        )
      ).rows[0]!.n,
    );

  async function queueEmail(status = "approved") {
    const order = await seedOrder(status);
    const address = `stop-${randomBytes(4).toString("hex")}@supplier-test.example`;
    const response = await send(sender.client, order.id, {
      channel: "email",
      email: address,
    });
    expect(response.status).toBe(200);
    return { order, address };
  }

  it("[proc-fix] revoke link -> job: provider not called, delivery failed with a reason", async () => {
    const { order, address } = await queueEmail();
    expect((await revoke(order.id)).body.data).toEqual({ revoked: 0 });
    const fake = new FakeEmailProvider();
    await runPurchasingPoEmailJob([tenantContext()], { email: fake });
    expect(fake.sent.some((item) => item.to === address)).toBe(false);
    expect(await deliveryOf(order.id)).toMatchObject({
      status: "failed",
      attempts: 0,
    });
    expect((await deliveryOf(order.id)).last_error).toBeTruthy();
  });

  it("[proc-fix] revokePurchaseOrderShareLinks keeps the link count and fails only queued deliveries", async () => {
    const { order } = await queueEmail();
    await send(sender.client, order.id, { channel: "share_link" });
    const count = await withTenant(db, tenantContext(), (tx) =>
      revokePurchaseOrderShareLinks(tx, tenantContext(), order.id),
    );
    expect(count).toBe(1);
    expect((await deliveryOf(order.id)).status).toBe("failed");
  });

  it("[proc-fix] close -> job: not sent, delivery failed", async () => {
    const { order, address } = await queueEmail();
    await transition(order.id, "close");
    const fake = new FakeEmailProvider();
    await runPurchasingPoEmailJob([tenantContext()], { email: fake });
    expect(fake.sent.some((item) => item.to === address)).toBe(false);
    expect((await deliveryOf(order.id)).status).toBe("failed");
  });

  it("[proc-fix] cancel -> job: not sent, delivery failed", async () => {
    const { order, address } = await queueEmail();
    await transition(order.id, "cancel");
    const fake = new FakeEmailProvider();
    await runPurchasingPoEmailJob([tenantContext()], { email: fake });
    expect(fake.sent.some((item) => item.to === address)).toBe(false);
    expect((await deliveryOf(order.id)).status).toBe("failed");
  });

  it("[proc-fix] the job fails permanently, with no retry, when the order is no longer sent", async () => {
    const { order, address } = await queueEmail();
    // Bypass the service revoke: the row is still queued, the order is closed.
    await owner.query(
      "UPDATE purchase_orders SET status = 'closed', closed_at = now() WHERE id = $1",
      [order.id],
    );
    const fake = new FakeEmailProvider();
    const result = await runPurchasingPoEmailJob([tenantContext()], {
      email: fake,
    });
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(fake.sent.some((item) => item.to === address)).toBe(false);
    expect(await deliveryOf(order.id)).toMatchObject({
      status: "failed",
      attempts: 1,
    });
    expect(await linkCount(order.id)).toBe(0);
  });

  it("[proc-fix] a public PDF link of a closed order is a 404", async () => {
    const order = await seedOrder("approved");
    const issued = await send(sender.client, order.id, {
      channel: "share_link",
    });
    const path = pathOf(issued.body.data.shareUrl as string);
    expect((await publicGet(path)).status).toBe(200);
    // Close without the service so the link itself stays live.
    await owner.query(
      "UPDATE purchase_orders SET status = 'closed', closed_at = now() WHERE id = $1",
      [order.id],
    );
    expect((await publicGet(path)).status).toBe(404);
  });

  it("[proc-fix] a retry reuses the same link: no new share-link row", async () => {
    const { order, address } = await queueEmail();
    let calls = 0;
    const bodies: string[] = [];
    const flaky = {
      send: async (
        _context: unknown,
        message: { to: string; body: string; reference: string },
      ) => {
        if (message.to === address) {
          calls += 1;
          bodies.push(message.body);
          if (calls === 1) throw new Error("smtp down");
        }
        return { accepted: true, reference: message.reference };
      },
    };
    const now = new Date();
    await runPurchasingPoEmailJob(
      [tenantContext()],
      { email: flaky as never },
      now,
    );
    expect(await deliveryOf(order.id)).toMatchObject({
      status: "queued",
      attempts: 1,
    });
    expect(await linkCount(order.id)).toBe(1);
    await runPurchasingPoEmailJob(
      [tenantContext()],
      { email: flaky as never },
      new Date(now.getTime() + 61_000),
    );
    expect(await deliveryOf(order.id)).toMatchObject({
      status: "sent",
      attempts: 2,
    });
    expect(await linkCount(order.id)).toBe(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it("[proc-fix] a retry whose link died fails the delivery and mints no new link", async () => {
    const { order, address } = await queueEmail();
    const failing = {
      send: async () => {
        throw new Error("smtp down");
      },
    };
    const now = new Date();
    await runPurchasingPoEmailJob([tenantContext()], { email: failing }, now);
    expect(await deliveryOf(order.id)).toMatchObject({
      status: "queued",
      attempts: 1,
    });
    // The link dies without the service revoke, so the row stays queued.
    await owner.query(
      "UPDATE purchase_order_share_links SET revoked_at = now() WHERE purchase_order_id = $1",
      [order.id],
    );
    const fake = new FakeEmailProvider();
    await runPurchasingPoEmailJob(
      [tenantContext()],
      { email: fake },
      new Date(now.getTime() + 61_000),
    );
    expect(fake.sent.some((item) => item.to === address)).toBe(false);
    expect(await deliveryOf(order.id)).toMatchObject({
      status: "failed",
      attempts: 2,
    });
    expect(await linkCount(order.id)).toBe(1);
  });

  // Holds the order FOR UPDATE (as close/cancel/revoke do) while the job runs.
  async function runWhileOrderLocked(
    orderId: string,
    email: FakeEmailProvider,
  ) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT id FROM purchase_orders WHERE id = $1 FOR UPDATE",
        [orderId],
      );
      return await runPurchasingPoEmailJob([tenantContext()], { email });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  it("[proc-fix] a locked order (55P03) leaves the delivery queued for a plain retry", async () => {
    const { order, address } = await queueEmail();
    const fake = new FakeEmailProvider();
    const result = await runWhileOrderLocked(order.id, fake);
    expect(result).toMatchObject({ sent: 0, failed: 0 });
    expect(fake.sent.some((item) => item.to === address)).toBe(false);
    expect(await deliveryOf(order.id)).toMatchObject({
      status: "queued",
      attempts: 1,
    });
    expect(await linkCount(order.id)).toBe(0);
  });

  it("[proc-fix] a first attempt that rolled back before the link is retried: link created, email sent", async () => {
    const { order, address } = await queueEmail();
    await runWhileOrderLocked(order.id, new FakeEmailProvider());
    expect(await linkCount(order.id)).toBe(0);
    const fake = new FakeEmailProvider();
    await runPurchasingPoEmailJob(
      [tenantContext()],
      { email: fake },
      new Date(Date.now() + 61_000),
    );
    expect(fake.sent.filter((item) => item.to === address)).toHaveLength(1);
    expect(await deliveryOf(order.id)).toMatchObject({
      status: "sent",
      attempts: 2,
    });
    expect(await linkCount(order.id)).toBe(1);
  });

  it("[proc-fix] the provider is called outside the transaction, and a concurrent run does not double-send", async () => {
    const { order, address } = await queueEmail();
    const now = new Date();
    let calls = 0;
    let lockFree = false;
    let leased = false;
    const probing = {
      send: async (
        _context: unknown,
        message: { to: string; reference: string },
      ) => {
        if (message.to !== address)
          return { accepted: true, reference: message.reference };
        calls += 1;
        // No transaction may hold the row: NOWAIT would throw 55P03.
        const client = await owner.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT id FROM purchase_order_email_deliveries WHERE id = $1 FOR UPDATE NOWAIT",
            [message.reference],
          );
          lockFree = true;
          const { rows } = await client.query<{ next_attempt_at: Date }>(
            "SELECT next_attempt_at FROM purchase_order_email_deliveries WHERE id = $1",
            [message.reference],
          );
          leased = rows[0]!.next_attempt_at > now;
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
        // A second worker running now must find the row leased.
        await runPurchasingPoEmailJob(
          [tenantContext()],
          { email: new FakeEmailProvider() },
          now,
        );
        return { accepted: true, reference: message.reference };
      },
    };
    await runPurchasingPoEmailJob(
      [tenantContext()],
      { email: probing as never },
      now,
    );
    expect(calls).toBe(1);
    expect(lockFree).toBe(true);
    expect(leased).toBe(true);
    expect(await deliveryOf(order.id)).toMatchObject({
      status: "sent",
      attempts: 1,
    });
  });
});

// legend-8a9w: a worker that dies after the provider took the email must not
// resend blindly on recovery (the provider's dedup window is only 30 minutes).
describe("8a9w ambiguous email attempt", () => {
  async function queued() {
    const order = await seedOrder("approved");
    const address = `amb-${randomBytes(4).toString("hex")}@supplier-test.example`;
    const response = await send(sender.client, order.id, {
      channel: "email",
      email: address,
    });
    expect(response.status).toBe(200);
    return { order, address };
  }

  const rowOf = async (orderId: string) =>
    (
      await owner.query<{
        id: string;
        status: string;
        attempts: number;
        last_error: string | null;
        send_started_at: Date | null;
      }>(
        "SELECT id, status, attempts, last_error, send_started_at FROM purchase_order_email_deliveries WHERE purchase_order_id = $1",
        [orderId],
      )
    ).rows[0]!;

  it("[8a9w] a crash after the provider call is not resent after the lease; it is failed for manual review", async () => {
    const { order, address } = await queued();
    const now = new Date();
    let firstCalls = 0;
    let markerDuringCall: Date | null = null;
    let reachedProvider!: () => void;
    const providerReached = new Promise<void>((resolve) => {
      reachedProvider = resolve;
    });
    // The provider took the message, but the worker never gets to step 3.
    const dying = {
      send: async (_context: unknown, message: { to: string }) => {
        if (message.to === address) {
          firstCalls += 1;
          const { rows } = await owner.query<{ send_started_at: Date | null }>(
            "SELECT send_started_at FROM purchase_order_email_deliveries WHERE purchase_order_id = $1",
            [order.id],
          );
          markerDuringCall = rows[0]!.send_started_at;
          reachedProvider();
          return new Promise(() => {});
        }
        return { accepted: true, reference: "x" };
      },
    };
    void runPurchasingPoEmailJob(
      [tenantContext()],
      { email: dying as never },
      now,
    );
    await providerReached;
    expect(firstCalls).toBe(1);
    // The attempt is recorded before the provider is called.
    expect(markerDuringCall).not.toBeNull();

    // Recovery well after the 30 minute dedup window and the lease.
    await owner.query(
      "UPDATE purchase_order_email_deliveries SET next_attempt_at = $2 WHERE purchase_order_id = $1",
      [order.id, new Date(now.getTime() - 1000)],
    );
    const fake = new FakeEmailProvider();
    const result = await runPurchasingPoEmailJob(
      [tenantContext()],
      { email: fake },
      new Date(now.getTime() + 3 * 60 * 60_000),
    );
    expect(fake.sent.some((item) => item.to === address)).toBe(false);
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    const row = await rowOf(order.id);
    expect(row).toMatchObject({ status: "failed", attempts: 1 });
    expect(row.last_error).toContain("tidak pasti");
    expect(row.last_error).not.toContain(address);
  });

  it("[8a9w] the normal path still sends once and clears the marker; a failed attempt retries", async () => {
    const { order, address } = await queued();
    let calls = 0;
    const flaky = {
      send: async (
        _context: unknown,
        message: { to: string; reference: string },
      ) => {
        if (message.to === address) {
          calls += 1;
          if (calls === 1) throw new Error("smtp down");
        }
        return { accepted: true, reference: message.reference };
      },
    };
    const now = new Date();
    await runPurchasingPoEmailJob(
      [tenantContext()],
      { email: flaky as never },
      now,
    );
    expect(await rowOf(order.id)).toMatchObject({
      status: "queued",
      attempts: 1,
      send_started_at: null,
    });
    await runPurchasingPoEmailJob(
      [tenantContext()],
      { email: flaky as never },
      new Date(now.getTime() + 61_000),
    );
    expect(await rowOf(order.id)).toMatchObject({
      status: "sent",
      attempts: 2,
      send_started_at: null,
    });
    expect(calls).toBe(2);
  });
});

describe("legend-ca3c authenticated PO PDF preview", () => {
  const preview = (
    client: ReturnType<typeof agent>,
    orderId: string,
    host = seededHostname,
  ) =>
    client
      .get(`/api/inventory/purchase-orders/${orderId}/preview.pdf`)
      .set("Host", host);
  it("renders a draft preview with no delivery, share-link or approval side effects", async () => {
    const order = await seedOrder("draft");
    const response = await preview(sender.client, order.id)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/pdf");
    expect(response.headers["content-disposition"]).toContain("inline;");
    expect(response.headers["cache-control"]).toContain("no-store");
    expect((response.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    const { rows } = await owner.query(
      `SELECT status, sent_at,
      (SELECT count(*)::int FROM purchase_order_share_links WHERE purchase_order_id = $1) AS links,
      (SELECT count(*)::int FROM purchase_order_email_deliveries WHERE purchase_order_id = $1) AS deliveries
      FROM purchase_orders WHERE id = $1`,
      [order.id],
    );
    expect(rows[0]).toMatchObject({
      status: "draft",
      sent_at: null,
      links: 0,
      deliveries: 0,
    });
  });
  it("requires a session, purchasing permission and the order tenant", async () => {
    const order = await seedOrder("draft");
    expect((await preview(agent(app), order.id)).status).toBe(401);
    expect((await preview(outsider.client, order.id)).status).toBe(403);
    expect(
      (await preview(staffB.client, order.id, tenantB.hostname)).status,
    ).toBe(404);
    expect((await preview(sender.client, randomUUID())).status).toBe(404);
  });
  it("keeps header totals and line values on one committed draft version during an edit", async () => {
    const order = await seedOrder("draft");
    const writer = await owner.connect();
    let pending: Promise<import("supertest").Response> | undefined;
    try {
      await writer.query("BEGIN");
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      await writer.query(
        "SELECT id FROM purchase_orders WHERE id = $1 FOR UPDATE",
        [order.id],
      );
      await writer.query(
        "LOCK TABLE purchase_order_lines IN ACCESS EXCLUSIVE MODE",
      );
      await writer.query(
        "UPDATE purchase_orders SET subtotal_idr = 74000, total_idr = 74000 WHERE id = $1",
        [order.id],
      );
      await writer.query(
        "UPDATE purchase_order_lines SET quantity = quantity * 2, line_total_idr = line_total_idr * 2 WHERE purchase_order_id = $1",
        [order.id],
      );
      pending = preview(sender.client, order.id)
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => done(null, Buffer.concat(chunks)));
        })
        .then((response) => response);
      let blocked = false;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const result = await owner.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked",
          [pid],
        );
        if (result.rows[0].blocked) {
          blocked = true;
          break;
        }
        await owner.query("SELECT pg_sleep(0.01)");
      }
      expect(blocked, "Preview must reach the controlled database lock").toBe(
        true,
      );
      await writer.query("COMMIT");
      const response = await pending;
      expect(response.status).toBe(200);
      const text = allText(response.body as Buffer);
      expect(text).toContain("Rp 74.000");
      expect(text).not.toContain("Rp 37.000");
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await pending?.catch(() => undefined);
    }
  });
});
