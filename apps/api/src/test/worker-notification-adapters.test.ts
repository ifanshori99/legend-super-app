// Production notification adapters (bead legend-18qw, Part N): provider env
// parsing, the Brevo email adapter (fake fetch, no keys) and the recipient
// resolver against the disposable PostgreSQL (RLS on, app role).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createUlid } from "@starter/shared/core";
import {
  cafeLegendFixtures,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { emailRequestSchema } from "@starter/shared/adapters";
import { eventEnvelopeSchema, eventFixture } from "@starter/shared/events";
import { notificationSchema } from "@starter/shared/notification";
import * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  brevoIdempotencyKey,
  createBrevoEmailProvider,
  createNotificationRecipientResolver,
  createWorkerNotificationHandlers,
  parseNotificationProviderEnv,
} from "../worker/notification-adapters.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(appPool, { schema });
const tenantId = cafeLegendFixtures.tenant.id;
const brandId = cafeLegendFixtures.brand.id;
const bandung = cafeLegendFixtures.outlets[0].id;
const bandung2 = cafeLegendFixtures.outlets[1].id;
const tenantB = randomUUID();
const tenantBUser = randomUUID();
const tenantBRole = randomUUID();
const tenantContext = (id: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId: id, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
const context = tenantContext(tenantId);

const disabledEnv = {
  NOTIFICATION_EMAIL_PROVIDER: "disabled",
  NOTIFICATION_PUSH_PROVIDER: "disabled",
  NOTIFICATION_WHATSAPP_PROVIDER: "disabled",
};
const brevoEnv = {
  ...disabledEnv,
  NOTIFICATION_EMAIL_PROVIDER: "brevo",
  BREVO_API_KEY: "xkeysib-test-secret-value",
  NOTIFICATION_EMAIL_FROM: "noreply@example.test",
  NOTIFICATION_EMAIL_FROM_NAME: "Legend",
};

// ---- Brevo adapter and env (no database) -------------------------------------

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}
const emailRequest = emailRequestSchema.parse({
  tenantId,
  outletId: bandung,
  reference: "attempt-key-1",
  to: "staf@example.test",
  subject: "Judul",
  body: "Isi pesan",
});
const brevo = (fetch: typeof globalThis.fetch) =>
  createBrevoEmailProvider({
    apiKey: "xkeysib-test-secret-value",
    from: "noreply@example.test",
    fromName: "Legend",
    fetch,
  });

describe("legend-18qw brevo email adapter", () => {
  it("legend-18qw posts the documented request and returns the provider message id", async () => {
    const { calls, fetch } = fakeFetch(
      () =>
        new Response(JSON.stringify({ messageId: "<m1@brevo>" }), {
          status: 201,
        }),
    );
    const result = await brevo(fetch).send(context, emailRequest);
    expect(result).toEqual({ reference: "<m1@brevo>", accepted: true });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "api-key": "xkeysib-test-secret-value",
      "content-type": "application/json",
      accept: "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      sender: { email: "noreply@example.test", name: "Legend" },
      to: [{ email: "staf@example.test" }],
      subject: "Judul",
      textContent: "Isi pesan",
      headers: {
        idempotencyKey: brevoIdempotencyKey("attempt-key-1"),
        "X-Legend-Reference": "attempt-key-1",
      },
      tags: ["legend-notification"],
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("legend-18qw falls back to the attempt reference when the 2xx body has no message id", async () => {
    const { fetch } = fakeFetch(
      () => new Response("not json", { status: 202 }),
    );
    await expect(brevo(fetch).send(context, emailRequest)).resolves.toEqual({
      reference: "attempt-key-1",
      accepted: true,
    });
  });

  it("legend-18qw declines only 400/422 and throws on every other failure", async () => {
    for (const status of [400, 422]) {
      const { fetch } = fakeFetch(() => new Response("{}", { status }));
      await expect(brevo(fetch).send(context, emailRequest)).resolves.toEqual({
        reference: "attempt-key-1",
        accepted: false,
      });
    }
    // A reused idempotency key is the acknowledgement whatever 4xx carries it
    // (Brevo does not document the status).
    for (const status of [400, 409, 422]) {
      const { fetch } = fakeFetch(
        () =>
          new Response(JSON.stringify({ code: "duplicate_parameter" }), {
            status,
          }),
      );
      await expect(brevo(fetch).send(context, emailRequest)).resolves.toEqual({
        reference: "attempt-key-1",
        accepted: true,
      });
    }
    // A bad or revoked key, an unverified sender and timeouts retry visibly.
    for (const status of [401, 403, 404, 408, 429, 500, 503]) {
      const { fetch } = fakeFetch(() => new Response("{}", { status }));
      await expect(brevo(fetch).send(context, emailRequest)).rejects.toThrow(
        String(status),
      );
    }
    const failing = (async () => {
      throw new TypeError("network down");
    }) as typeof globalThis.fetch;
    await expect(brevo(failing).send(context, emailRequest)).rejects.toThrow(
      "network down",
    );
  });

  it("legend-18qw a lost response is retried with the same idempotency key and the duplicate counts as sent", async () => {
    // A fake Brevo that sends once per idempotency key (30-minute window) and
    // answers a reused key with duplicate_parameter, like the real API.
    const sentKeys: string[] = [];
    const seen = new Set<string>();
    let loseResponse = true;
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        headers: { idempotencyKey: string };
      };
      const key = body.headers.idempotencyKey;
      if (seen.has(key))
        return new Response(
          JSON.stringify({
            code: "duplicate_parameter",
            message: "Duplicate idempotency key",
          }),
          { status: 400 },
        );
      seen.add(key);
      sentKeys.push(key);
      if (loseResponse) {
        loseResponse = false;
        // Accepted and sent, but the response never reaches the worker.
        throw new TypeError("socket hang up");
      }
      return new Response(JSON.stringify({ messageId: "<m@brevo>" }), {
        status: 201,
      });
    }) as typeof globalThis.fetch;
    const provider = brevo(fetch);
    await expect(provider.send(context, emailRequest)).rejects.toThrow(
      "socket hang up",
    );
    // The retry of the same attempt is acknowledged, not sent again.
    await expect(provider.send(context, emailRequest)).resolves.toEqual({
      reference: emailRequest.reference,
      accepted: true,
    });
    expect(sentKeys).toHaveLength(1);
    expect(sentKeys[0]).toBe(brevoIdempotencyKey(emailRequest.reference));
    expect(sentKeys[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // Another attempt gets another key, so it is really sent.
    expect(brevoIdempotencyKey("attempt-key-2")).not.toBe(sentKeys[0]);
  });

  it("legend-18qw validates the request and refuses another tenant before any I/O", async () => {
    const { calls, fetch } = fakeFetch(
      () => new Response("{}", { status: 200 }),
    );
    await expect(
      brevo(fetch).send(context, { ...emailRequest, to: "bukan-email" }),
    ).rejects.toThrow();
    await expect(
      brevo(fetch).send(tenantContext(tenantB), emailRequest),
    ).rejects.toThrow("Tenant mismatch");
    expect(calls).toHaveLength(0);
  });
});

describe("legend-18qw notification provider env", () => {
  it("legend-18qw parses disabled and brevo configurations", () => {
    expect(parseNotificationProviderEnv(disabledEnv)).toEqual({
      email: { provider: "disabled" },
      push: { provider: "disabled" },
      whatsapp: { provider: "disabled" },
    });
    expect(parseNotificationProviderEnv(brevoEnv).email).toEqual({
      provider: "brevo",
      apiKey: "xkeysib-test-secret-value",
      from: "noreply@example.test",
      fromName: "Legend",
    });
  });

  it("legend-18qw refuses a missing provider key and names the key, not a value", () => {
    for (const key of [
      "NOTIFICATION_EMAIL_PROVIDER",
      "NOTIFICATION_PUSH_PROVIDER",
      "NOTIFICATION_WHATSAPP_PROVIDER",
    ]) {
      const env: Record<string, string | undefined> = { ...disabledEnv };
      delete env[key];
      expect(() => parseNotificationProviderEnv(env)).toThrow(key);
    }
    expect(() => parseNotificationProviderEnv({})).toThrow(
      /NOTIFICATION_EMAIL_PROVIDER.*NOTIFICATION_PUSH_PROVIDER.*NOTIFICATION_WHATSAPP_PROVIDER/,
    );
    const invalid = { ...disabledEnv, NOTIFICATION_EMAIL_PROVIDER: "sendgrid" };
    expect(() => parseNotificationProviderEnv(invalid)).toThrow(
      "NOTIFICATION_EMAIL_PROVIDER",
    );
    expect(() => parseNotificationProviderEnv(invalid)).not.toThrow(/sendgrid/);
    expect(() =>
      parseNotificationProviderEnv({
        ...disabledEnv,
        NOTIFICATION_PUSH_PROVIDER: "",
      }),
    ).toThrow("NOTIFICATION_PUSH_PROVIDER");
  });

  it("legend-18qw rejects brevo without an api key or a valid sender", () => {
    const withoutKey: Record<string, string | undefined> = { ...brevoEnv };
    delete withoutKey.BREVO_API_KEY;
    expect(() => parseNotificationProviderEnv(withoutKey)).toThrow(
      "BREVO_API_KEY",
    );
    const withoutFrom: Record<string, string | undefined> = { ...brevoEnv };
    delete withoutFrom.NOTIFICATION_EMAIL_FROM;
    expect(() => parseNotificationProviderEnv(withoutFrom)).toThrow(
      "NOTIFICATION_EMAIL_FROM",
    );
    expect(() =>
      parseNotificationProviderEnv({
        ...brevoEnv,
        NOTIFICATION_EMAIL_FROM: "bukan-email",
      }),
    ).toThrow("NOTIFICATION_EMAIL_FROM");
    try {
      parseNotificationProviderEnv(withoutFrom);
    } catch (error) {
      expect(String(error)).not.toContain("xkeysib-test-secret-value");
    }
  });

  it("legend-18qw refuses a malformed api key and a placeholder sender at startup, naming only the key", () => {
    for (const apiKey of [
      "xkeysib with space",
      "xkeysib-\u00e9",
      "replace_me",
    ]) {
      let message = "";
      try {
        parseNotificationProviderEnv({ ...brevoEnv, BREVO_API_KEY: apiKey });
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("BREVO_API_KEY is not a valid API key");
      expect(message).not.toContain(apiKey);
    }
    for (const from of ["noreply@legend.invalid", "replace_me@example.test"])
      expect(() =>
        parseNotificationProviderEnv({
          ...brevoEnv,
          NOTIFICATION_EMAIL_FROM: from,
        }),
      ).toThrow("NOTIFICATION_EMAIL_FROM must be a real sender address");
  });

  it("legend-18qw disabled providers refuse to send and brevo is wired through the handlers", async () => {
    const disabled = createWorkerNotificationHandlers(database, disabledEnv);
    await expect(
      disabled.notificationDelivery.email.send(context, emailRequest),
    ).rejects.toThrow("email provider is disabled");
    await expect(
      disabled.notificationDelivery.push.send(context, {} as never),
    ).rejects.toThrow("push provider is disabled");
    // Absent, not a disabled stub: worker-main polls WhatsApp attempts only
    // when the provider is present.
    expect(disabled.notificationDelivery.whatsapp).toBeUndefined();
    expect("whatsapp" in disabled.notificationDelivery).toBe(false);
    const { calls, fetch } = fakeFetch(
      () => new Response(JSON.stringify({ messageId: "m2" }), { status: 201 }),
    );
    const wired = createWorkerNotificationHandlers(database, brevoEnv, {
      fetch,
    });
    await expect(
      wired.notificationDelivery.email.send(context, emailRequest),
    ).resolves.toEqual({ reference: "m2", accepted: true });
    expect(calls).toHaveLength(1);
    expect(() =>
      createWorkerNotificationHandlers(database, {
        ...disabledEnv,
        NOTIFICATION_EMAIL_PROVIDER: undefined,
      }),
    ).toThrow("NOTIFICATION_EMAIL_PROVIDER");
  });
});

// ---- Recipient resolver (database) -------------------------------------------

const createdUserIds: string[] = [];
const requestIds: string[] = [];
const users = {} as Record<
  | "requester"
  | "outletApprover"
  | "otherOutletApprover"
  | "brandApprover"
  | "tenantApprover"
  | "lapsedApprover"
  | "cashier"
  | "tenantOwner"
  | "outletOwner",
  string
>;

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function createUser(
  name: string,
  templateKey: string,
  scope: { type: string; id?: string },
  options: { validFrom?: string; validUntil?: string; verified?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, $4)`,
    [id, name, `${id}@example.test`, options.verified ?? false],
  );
  createdUserIds.push(id);
  // Backdated: the container clock may drift from the Node clock.
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() + $6::interval, ${
       options.validUntil ? "now() + $7::interval" : "$7::timestamptz"
     }, $2)`,
    [
      tenantId,
      id,
      await roleIdOf(templateKey),
      scope.type,
      scope.id ?? null,
      options.validFrom ?? "-1 hour",
      options.validUntil ?? null,
    ],
  );
  return id;
}

async function insertApprovalRequest(input: {
  tenant?: string;
  outletId: string | null;
  requestedBy: string;
  approverRoleIds: string[];
  decided?: { by: string; status?: string };
}): Promise<string> {
  const id = randomUUID();
  requestIds.push(id);
  const status = input.decided?.status ?? "rejected";
  const isDecision = status === "approved" || status === "rejected";
  await owner.query(
    `INSERT INTO approval_requests
       (id, tenant_id, outlet_id, chain_id, source_module, action_type, object_type, object_id,
        requested_by, source, level, required_levels, required_steps, status,
        decided_by, decided_at, reason, request_reason, deadline_at)
     VALUES ($1, $2, $3, $1, 'payment', 'void', 'order', $4, $5, 'user', 1, 1, $6::jsonb, $7,
             $8, $9, $10, 'Permintaan uji notifikasi', now() + interval '1 hour')`,
    [
      id,
      input.tenant ?? tenantId,
      input.outletId,
      randomUUID(),
      input.requestedBy,
      JSON.stringify([{ level: 1, approverRoleIds: input.approverRoleIds }]),
      input.decided ? status : "pending",
      // The decision check only allows a decider and reason on approved/rejected;
      // expired and cancelled rows carry none.
      input.decided && isDecision ? input.decided.by : null,
      input.decided && isDecision ? new Date() : null,
      input.decided && isDecision ? "Ditolak dalam uji" : null,
    ],
  );
  return id;
}

function envelope(
  name: string,
  outletId: string | null,
  payload: Record<string, unknown>,
) {
  return eventEnvelopeSchema.parse({
    ...eventFixture,
    id: createUlid(),
    tenantId,
    outletId,
    name,
    aggregateType: name.split(".")[0],
    aggregateId: createUlid(),
    idempotencyKey: `${name}-${randomUUID()}`,
    payloadSchemaRef: `${name}.v1`,
    payload,
  });
}

const resolve = (
  channels: { email: boolean; push: boolean },
  event: ReturnType<typeof envelope>,
) =>
  withTenant(database, context, (tx) =>
    createNotificationRecipientResolver(channels)(context, event, tx),
  );
/** Seeded fixture users may match the same roles; assert only on our own. */
const ours = <T extends { userId: string }>(recipients: T[]) =>
  recipients.filter((recipient) => createdUserIds.includes(recipient.userId));

describe("legend-18qw notification recipient resolver", () => {
  beforeAll(async () => {
    users.requester = await createUser("Pemohon", "supervisor", {
      type: "tenant",
    });
    users.outletApprover = await createUser(
      "Penyetuju outlet",
      "supervisor",
      { type: "outlet", id: bandung },
      { verified: true },
    );
    users.otherOutletApprover = await createUser(
      "Penyetuju outlet lain",
      "supervisor",
      {
        type: "outlet",
        id: bandung2,
      },
    );
    users.brandApprover = await createUser("Penyetuju brand", "supervisor", {
      type: "brand",
      id: brandId,
    });
    users.tenantApprover = await createUser("Penyetuju tenant", "supervisor", {
      type: "tenant",
    });
    users.lapsedApprover = await createUser(
      "Penyetuju lewat",
      "supervisor",
      { type: "tenant" },
      { validFrom: "-2 hours", validUntil: "-1 hour" },
    );
    users.cashier = await createUser("Kasir", "cashier", {
      type: "outlet",
      id: bandung,
    });
    users.tenantOwner = await createUser("Pemilik tenant", "owner", {
      type: "tenant",
    });
    users.outletOwner = await createUser("Pemilik outlet", "owner", {
      type: "outlet",
      id: bandung,
    });
    // A web push subscription and a stored preference for one approver.
    await owner.query(
      `INSERT INTO push_subscriptions (tenant_id, id, user_id, endpoint_hash, subscription_ciphertext, key_version, registered_at)
     VALUES ($1, $2, $3, 'hash-18qw', 'cipher', 'v1', now())`,
      [tenantId, randomUUID(), users.outletApprover],
    );
    await owner.query(
      `INSERT INTO notification_preferences (tenant_id, user_id, categories, quiet_hours, time_zone)
     VALUES ($1, $2, '{}'::jsonb, NULL, 'Asia/Makassar')`,
      [tenantId, users.outletApprover],
    );
    // A second tenant holding a role and user the first tenant must never see.
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Adapter test tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
      [tenantB, `adapters-${tenantB}`, tenantBUser],
    );
    await owner.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'B', $2)`,
      [tenantBUser, `${tenantBUser}@example.test`],
    );
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, 'Penyetuju B', false, '[]'::jsonb, '["tenant"]'::jsonb)`,
      [tenantBRole, tenantB],
    );
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, assigned_by, valid_from)
     VALUES ($1, $2, $3, 'tenant', $2, now() - interval '1 hour')`,
      [tenantB, tenantBUser, tenantBRole],
    );
  });

  afterAll(async () => {
    await owner.query(
      `DELETE FROM approval_requests WHERE id = ANY($1::uuid[])`,
      [requestIds],
    );
    await owner.query(
      `DELETE FROM push_subscriptions WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`,
      [tenantId, createdUserIds],
    );
    await owner.query(
      `DELETE FROM notification_preferences WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`,
      [tenantId, createdUserIds],
    );
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = ANY($1::uuid[]) AND user_id = ANY($2::text[])",
      [
        [tenantId, tenantB],
        [...createdUserIds, tenantBUser],
      ],
    );
    await owner.query("DELETE FROM roles WHERE tenant_id = $1", [tenantB]);
    await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
    await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
      [...createdUserIds, tenantBUser],
    ]);
  });

  it("legend-18qw approval.requested reaches in-scope approvers only, never the requester or another tenant", async () => {
    const requestId = await insertApprovalRequest({
      outletId: bandung,
      requestedBy: users.requester,
      // A foreign role id in the snapshot must not leak the other tenant's user.
      approverRoleIds: [await roleIdOf("supervisor"), tenantBRole],
    });
    const event = envelope("approval.requested", bandung, {
      requestId,
      actionType: "void",
      objectType: "order",
      objectId: randomUUID(),
      source: "user",
      level: 1,
      requiredLevels: 1,
      requestedBy: users.requester,
      amountIdr: null,
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const recipients = await resolve({ email: true, push: true }, event);
    expect(recipients.map((r) => r.userId)).not.toContain(users.requester);
    expect(recipients.map((r) => r.userId)).not.toContain(tenantBUser);
    expect(
      ours(recipients)
        .map((r) => r.userId)
        .sort(),
    ).toEqual(
      [users.outletApprover, users.brandApprover, users.tenantApprover].sort(),
    );
    const outletApprover = recipients.find(
      (r) => r.userId === users.outletApprover,
    );
    expect(outletApprover).toMatchObject({
      category: "approval_request",
      link: `/kelola/persetujuan/${requestId}`,
      whatsappSentThisMonth: expect.any(Number),
      defaultTimeZone: "Asia/Makassar",
      reachability: {
        hasPushSubscription: true,
        hasVerifiedEmail: true,
        whatsappOptIn: false,
      },
    });
    expect(outletApprover?.preference?.timeZone).toBe("Asia/Makassar");
    expect(outletApprover?.policy.tenantId).toBe(tenantId);
    const tenantApprover = recipients.find(
      (r) => r.userId === users.tenantApprover,
    );
    expect(tenantApprover?.reachability).toEqual({
      hasPushSubscription: false,
      hasVerifiedEmail: false,
      // legend-fy5y: a real but unverified address (only the first-admin
      // invitation may use it; the approval category ignores it).
      hasUnverifiedEmail: true,
      whatsappOptIn: false,
    });
    expect(tenantApprover?.defaultTimeZone).toBe("Asia/Jakarta");
    // Content stays generic: no amounts, ids of objects or secrets.
    expect(outletApprover?.body).not.toMatch(/\d{3}/);
  });

  it("legend-18qw a delayed approval.requested for a decided request or another level pages nobody", async () => {
    const payload = (requestId: string, level: number) => ({
      requestId,
      actionType: "void",
      objectType: "order",
      objectId: randomUUID(),
      source: "user",
      level,
      requiredLevels: 2,
      requestedBy: users.requester,
      amountIdr: null,
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const decided = await insertApprovalRequest({
      outletId: bandung,
      requestedBy: users.requester,
      approverRoleIds: [await roleIdOf("supervisor")],
      decided: { by: users.tenantApprover },
    });
    expect(
      await resolve(
        { email: true, push: true },
        envelope("approval.requested", bandung, payload(decided, 1)),
      ),
    ).toEqual([]);
    const pending = await insertApprovalRequest({
      outletId: bandung,
      requestedBy: users.requester,
      approverRoleIds: [await roleIdOf("supervisor")],
    });
    // The row is at level 1; an event naming level 2 is not this level's.
    expect(
      await resolve(
        { email: true, push: true },
        envelope("approval.requested", bandung, payload(pending, 2)),
      ),
    ).toEqual([]);
  });

  it("legend-18qw a tenant-wide approval.requested reaches tenant-scope approvers only", async () => {
    const requestId = await insertApprovalRequest({
      outletId: null,
      requestedBy: users.requester,
      approverRoleIds: [await roleIdOf("supervisor")],
    });
    const event = envelope("approval.requested", null, {
      requestId,
      actionType: "void",
      objectType: "order",
      objectId: randomUUID(),
      source: "user",
      level: 1,
      requiredLevels: 1,
      requestedBy: users.requester,
      amountIdr: null,
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const recipients = await resolve({ email: true, push: true }, event);
    expect(ours(recipients).map((r) => r.userId)).toEqual([
      users.tenantApprover,
    ]);
  });

  it("legend-18qw approval.requested skips holders whose assignment is expired or not yet valid", async () => {
    // Same role and tenant scope as tenantApprover, but the window is not open.
    const notYetValid = await createUser(
      "Penyetuju belum berlaku",
      "supervisor",
      { type: "tenant" },
      { validFrom: "+1 hour" },
    );
    const requestId = await insertApprovalRequest({
      outletId: bandung,
      requestedBy: users.requester,
      approverRoleIds: [await roleIdOf("supervisor")],
    });
    const event = envelope("approval.requested", bandung, {
      requestId,
      actionType: "void",
      objectType: "order",
      objectId: randomUUID(),
      source: "user",
      level: 1,
      requiredLevels: 1,
      requestedBy: users.requester,
      amountIdr: null,
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const ids = ours(await resolve({ email: true, push: true }, event)).map(
      (r) => r.userId,
    );
    expect(ids).not.toContain(users.lapsedApprover);
    expect(ids).not.toContain(notYetValid);
    // The active holders are still paged, so the skip is not an empty result.
    expect(ids).toContain(users.tenantApprover);
    expect(ids).toContain(users.outletApprover);
  });

  it("legend-18qw disabled channels are never reachable", async () => {
    const requestId = await insertApprovalRequest({
      outletId: bandung,
      requestedBy: users.requester,
      approverRoleIds: [await roleIdOf("supervisor")],
    });
    const event = envelope("approval.requested", bandung, {
      requestId,
      actionType: "void",
      objectType: "order",
      objectId: randomUUID(),
      source: "user",
      level: 1,
      requiredLevels: 1,
      requestedBy: users.requester,
      amountIdr: null,
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const recipients = await resolve({ email: false, push: false }, event);
    const outletApprover = recipients.find(
      (r) => r.userId === users.outletApprover,
    );
    expect(outletApprover).toBeDefined();
    for (const recipient of ours(recipients))
      expect(recipient.reachability).toEqual({
        hasPushSubscription: false,
        hasVerifiedEmail: false,
        hasUnverifiedEmail: false,
        whatsappOptIn: false,
      });
  });

  it("legend-18qw approval.resolved notifies the requester re-read from the request row", async () => {
    const requestId = await insertApprovalRequest({
      outletId: bandung,
      requestedBy: users.outletApprover,
      approverRoleIds: [await roleIdOf("supervisor")],
      decided: { by: users.tenantApprover },
    });
    const event = envelope("approval.resolved", bandung, {
      chainId: requestId,
      requestId,
      sourceModule: "payment",
      actionType: "void",
      objectType: "order",
      objectId: randomUUID(),
      source: "user",
      outcome: "rejected",
      level: 1,
      requiredLevels: 1,
      // Not the real requester: the payload id must be ignored.
      requestedBy: users.cashier,
      decidedBy: users.tenantApprover,
      amountIdr: null,
    });
    const recipients = await resolve({ email: true, push: true }, event);
    expect(recipients).toHaveLength(1);
    expect(recipients[0]).toMatchObject({
      userId: users.outletApprover,
      category: "approval_request",
      title: "Permintaan ditolak",
      link: `/kelola/persetujuan/${requestId}`,
    });
  });

  it.each([
    ["approved", /disetujui/i],
    ["rejected", /ditolak/i],
    ["expired", /kedaluwarsa/i],
    ["cancelled", /dibatalkan/i],
  ] as const)(
    "legend-18qw approval.resolved (%s) reaches the requester with its own text",
    async (outcome, titlePattern) => {
      const requestId = await insertApprovalRequest({
        outletId: bandung,
        requestedBy: users.outletApprover,
        approverRoleIds: [await roleIdOf("supervisor")],
        decided: { by: users.tenantApprover, status: outcome },
      });
      const event = envelope("approval.resolved", bandung, {
        chainId: requestId,
        requestId,
        sourceModule: "payment",
        actionType: "void",
        objectType: "order",
        objectId: randomUUID(),
        source: "user",
        outcome,
        level: 1,
        requiredLevels: 1,
        requestedBy: users.outletApprover,
        decidedBy: users.tenantApprover,
        amountIdr: null,
      });
      const recipients = await resolve({ email: true, push: true }, event);
      expect(recipients.map((r) => r.userId)).toEqual([users.outletApprover]);
      expect(recipients[0]).toMatchObject({
        category: "approval_request",
        link: `/kelola/persetujuan/${requestId}`,
      });
      expect(recipients[0]?.title).toMatch(titlePattern);
    },
  );

  it("legend-18qw a banned account is never notified; a malformed preference falls back to defaults", async () => {
    const supervisor = await roleIdOf("supervisor");
    const resolved = (requestId: string) =>
      envelope("approval.resolved", bandung, {
        chainId: requestId,
        requestId,
        sourceModule: "payment",
        actionType: "void",
        objectType: "order",
        objectId: randomUUID(),
        source: "user",
        outcome: "rejected",
        level: 1,
        requiredLevels: 1,
        requestedBy: users.cashier,
        decidedBy: users.tenantApprover,
        amountIdr: null,
      });
    const banned = await createUser(
      "Pemohon diblokir",
      "supervisor",
      { type: "tenant" },
      { verified: true },
    );
    await owner.query(`UPDATE "user" SET banned = true WHERE id = $1`, [
      banned,
    ]);
    const bannedRequest = await insertApprovalRequest({
      outletId: bandung,
      requestedBy: banned,
      approverRoleIds: [supervisor],
      decided: { by: users.tenantApprover },
    });
    expect(
      await resolve({ email: true, push: true }, resolved(bannedRequest)),
    ).toEqual([]);

    const odd = await createUser(
      "Preferensi rusak",
      "supervisor",
      { type: "tenant" },
      { verified: true },
    );
    await owner.query(
      `INSERT INTO notification_preferences (tenant_id, user_id, categories, quiet_hours, time_zone)
     VALUES ($1, $2, '{"approval_request": "not-a-setting"}'::jsonb, NULL, 'Asia/Jakarta')`,
      [tenantId, odd],
    );
    const oddRequest = await insertApprovalRequest({
      outletId: bandung,
      requestedBy: odd,
      approverRoleIds: [supervisor],
      decided: { by: users.tenantApprover },
    });
    const recipients = await resolve(
      { email: true, push: false },
      resolved(oddRequest),
    );
    expect(recipients).toHaveLength(1);
    expect(recipients[0]).toMatchObject({ userId: odd, preference: null });
  });

  it("legend-18qw approval events fail closed when the request row is missing or from another outlet", async () => {
    const payload = {
      requestId: randomUUID(),
      actionType: "void",
      objectType: "order",
      objectId: randomUUID(),
      source: "user",
      level: 1,
      requiredLevels: 1,
      requestedBy: users.requester,
      amountIdr: null,
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    await expect(
      resolve(
        { email: true, push: true },
        envelope("approval.requested", bandung, payload),
      ),
    ).rejects.toThrow("Approval request not found");
    const requestId = await insertApprovalRequest({
      outletId: bandung,
      requestedBy: users.requester,
      approverRoleIds: [await roleIdOf("supervisor")],
    });
    await expect(
      resolve(
        { email: true, push: true },
        envelope("approval.requested", bandung2, { ...payload, requestId }),
      ),
    ).rejects.toThrow("outlet does not match");
  });

  it("legend-18qw support access events reach tenant-scope settings managers only", async () => {
    for (const name of ["support_access.granted", "support_access.ended"]) {
      const event = envelope(name, null, {});
      const recipients = await resolve({ email: true, push: true }, event);
      const mine = ours(recipients).map((r) => r.userId);
      expect(mine).toEqual([users.tenantOwner]);
      expect(recipients[0]?.category).toBe("security");
    }
  });

  it("legend-c9kbk TEN-04 support_access.requested pages only tenant-scope owner-template holders", async () => {
    // A non-owner who nevertheless holds the approve permission through a custom
    // tenant-scope role must not be paged: only owners may decide the request.
    const customRoleId = randomUUID();
    const customUserId = await createUser(
      "Pemegang izin kustom",
      "supervisor",
      { type: "tenant" },
    );
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, 'Penyetuju dukungan kustom notif', false, $3::jsonb, '["tenant"]'::jsonb)`,
      [customRoleId, tenantId, JSON.stringify(["org.support_access.approve"])],
    );
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', now() - interval '1 hour', $2)`,
      [tenantId, customUserId, customRoleId],
    );
    try {
      const event = envelope("support_access.requested", null, {});
      const recipients = await resolve({ email: true, push: true }, event);
      // Only the tenant-scope owner; not the outlet-scope owner, supervisors,
      // the cashier, the lapsed approver or the custom-role holder.
      expect(ours(recipients).map((r) => r.userId)).toEqual([
        users.tenantOwner,
      ]);
    } finally {
      await owner.query(
        `DELETE FROM role_assignments WHERE tenant_id = $1 AND role_id = $2`,
        [tenantId, customRoleId],
      );
      await owner.query(`DELETE FROM roles WHERE id = $1`, [customRoleId]);
    }
  });

  it("legend-18qw checklist events alert outlet supervisors, not the assignee", async () => {
    const payload = {
      runId: randomUUID(),
      templateId: randomUUID(),
      shiftDate: "2026-11-08",
      assignedTo: users.outletApprover,
      dueAt: "2026-11-08T03:00:00.000Z",
      detectedAt: "2026-11-08T03:05:00.000Z",
    };
    const recipients = await resolve(
      { email: true, push: true },
      envelope("checklist.missed", bandung, payload),
    );
    const mine = ours(recipients).map((r) => r.userId);
    expect(mine).toContain(users.tenantApprover);
    expect(mine).toContain(users.brandApprover);
    expect(mine).not.toContain(users.outletApprover);
    expect(mine).not.toContain(users.otherOutletApprover);
    expect(mine).not.toContain(users.cashier);
    expect(mine).not.toContain(users.lapsedApprover);
  });

  it("legend-5rgl facility_incident.raised pages in-scope booth operators with the emergency category", async () => {
    const roleId = randomUUID();
    const facilityId = randomUUID();
    const incidentId = randomUUID();
    const respondedId = randomUUID();
    const otherOutletIncidentId = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, 'Operator bilik 5rgl', false, $3::jsonb, '["tenant","brand","outlet"]'::jsonb)`,
      [roleId, tenantId, JSON.stringify(["facility.booth.operate"])],
    );
    const grant = async (
      name: string,
      scope: { type: string; id?: string },
      options: { validUntil?: string } = {},
    ) => {
      const id = randomUUID();
      await owner.query(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, false)`,
        [id, name, `${id}@example.test`],
      );
      createdUserIds.push(id);
      await owner.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
         VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', ${
           options.validUntil ? "now() + $6::interval" : "$6::timestamptz"
         }, $2)`,
        [
          tenantId,
          id,
          roleId,
          scope.type,
          scope.id ?? null,
          options.validUntil ?? null,
        ],
      );
      return id;
    };
    const operator = await grant("Operator outlet", {
      type: "outlet",
      id: bandung,
    });
    const otherOutletOperator = await grant("Operator outlet lain", {
      type: "outlet",
      id: bandung2,
    });
    const lapsedOperator = await grant(
      "Operator lewat",
      { type: "outlet", id: bandung },
      { validUntil: "-1 minute" },
    );
    const insertIncident = (id: string, outletId: string, responded: boolean) =>
      owner.query(
        `INSERT INTO facility_incidents
           (id, tenant_id, outlet_id, facility_id, type, triggered_at, responded_by, responded_at)
         VALUES ($1, $2, $3, $4, 'panic', now(), $5, $6)`,
        [
          id,
          tenantId,
          outletId,
          facilityId,
          responded ? operator : null,
          responded ? new Date() : null,
        ],
      );
    const raised = (id: string, outletId: string) =>
      envelope("facility_incident.raised", outletId, {
        incidentId: id,
        facilityId,
        unitId: null,
        type: "panic",
        triggeredAt: new Date().toISOString(),
        offline: false,
      });
    try {
      await owner.query(
        `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                                 arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
         VALUES ($1, $2, $3, 'Notif 5rgl', 'shower', 20, 10, 10, '[]', $4, $5)`,
        [
          facilityId,
          tenantId,
          bandung,
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
        ],
      );
      await insertIncident(incidentId, bandung, false);
      await insertIncident(respondedId, bandung, true);

      const recipients = await resolve(
        { email: true, push: true },
        raised(incidentId, bandung),
      );
      // Seeded supervisor templates may hold the permission too: assert on
      // the users this test granted it to, plus the roles that lack it.
      const mine = ours(recipients).map((r) => r.userId);
      expect(mine).toContain(operator);
      expect(mine).not.toContain(otherOutletOperator);
      expect(mine).not.toContain(lapsedOperator);
      expect(mine).not.toContain(users.cashier);
      expect(recipients[0]?.category).toBe("emergency");

      // Already answered: a delayed event pages nobody.
      expect(
        await resolve(
          { email: true, push: true },
          raised(respondedId, bandung),
        ),
      ).toEqual([]);

      // The event outlet must match the stored incident, and the row must exist.
      await expect(
        resolve({ email: true, push: true }, raised(incidentId, bandung2)),
      ).rejects.toThrow("outlet does not match");
      await expect(
        resolve(
          { email: true, push: true },
          raised(otherOutletIncidentId, bandung),
        ),
      ).rejects.toThrow("not found");
    } finally {
      await owner.query("DELETE FROM role_assignments WHERE role_id = $1", [
        roleId,
      ]);
      await owner.query(
        "DELETE FROM facility_incidents WHERE tenant_id = $1 AND facility_id = $2",
        [tenantId, facilityId],
      );
      await owner.query(
        "DELETE FROM facility_operating_hours_versions WHERE facility_id = $1",
        [facilityId],
      );
      await owner.query("DELETE FROM facilities WHERE id = $1", [facilityId]);
      await owner.query("DELETE FROM roles WHERE id = $1", [roleId]);
    }
  });

  it("legend-18qw a banned supervisor does not hide the owner fallback; an expired ban is active again", async () => {
    // An isolated tenant: the fixture tenant has seeded supervisors.
    const tenantC = randomUUID();
    const brandC = randomUUID();
    const legalC = randomUUID();
    const outletC = randomUUID();
    const supervisorRole = randomUUID();
    const ownerRole = randomUUID();
    const bannedSupervisor = randomUUID();
    const ownerC = randomUUID();
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Fallback test tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
      [tenantC, `adapters-c-${tenantC}`, ownerC],
    );
    await owner.query(
      "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand C')",
      [brandC, tenantC, `adapters-c-${tenantC.slice(0, 8)}`],
    );
    await owner.query(
      "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT C', false)",
      [legalC, tenantC],
    );
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, 'OUT-C', 'Outlet C', 'Jl. C', '{}')`,
      [outletC, tenantC, brandC, legalC],
    );
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, allowed_scope_types)
     VALUES ($1, $3, 'Supervisor', true, 'supervisor', '[]'::jsonb, '["tenant","brand","outlet"]'::jsonb),
            ($2, $3, 'Owner', true, 'owner', '[]'::jsonb, '["tenant"]'::jsonb)`,
      [supervisorRole, ownerRole, tenantC],
    );
    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified, banned) VALUES
       ($1, 'Supervisor diblokir', $3, true, false), ($2, 'Pemilik C', $4, true, false)`,
      [
        bannedSupervisor,
        ownerC,
        `${bannedSupervisor}@example.test`,
        `${ownerC}@example.test`,
      ],
    );
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, assigned_by, valid_from)
     VALUES ($1, $2, $3, 'outlet', $5, $4, now() - interval '1 hour'),
            ($1, $4, $6, 'tenant', NULL, $4, now() - interval '1 hour')`,
      [tenantC, bannedSupervisor, supervisorRole, ownerC, outletC, ownerRole],
    );
    // The ban comes after the grant, as in production: migration 0144 refuses a
    // role assignment to an account that is already banned.
    await owner.query(`UPDATE "user" SET banned = true WHERE id = $1`, [
      bannedSupervisor,
    ]);
    const contextC = tenantContext(tenantC);
    const event = {
      ...envelope("checklist.missed", bandung, {
        runId: randomUUID(),
        templateId: randomUUID(),
        shiftDate: "2026-11-08",
        assignedTo: randomUUID(),
        dueAt: "2026-11-08T03:00:00.000Z",
        detectedAt: "2026-11-08T03:05:00.000Z",
      }),
      tenantId: tenantC,
      outletId: outletC,
    } as ReturnType<typeof envelope>;
    const resolveC = () =>
      withTenant(database, contextC, (tx) =>
        createNotificationRecipientResolver({ email: true, push: false })(
          contextC,
          event,
          tx,
        ),
      );
    try {
      expect((await resolveC()).map((r) => r.userId)).toEqual([ownerC]);
      // The ban has expired: the supervisor takes the alert again.
      await owner.query(
        `UPDATE "user" SET ban_expires = now() - interval '1 minute' WHERE id = $1`,
        [bannedSupervisor],
      );
      expect((await resolveC()).map((r) => r.userId)).toEqual([
        bannedSupervisor,
      ]);
    } finally {
      await owner.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
        tenantC,
      ]);
      await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
        [bannedSupervisor, ownerC],
      ]);
    }
  });

  it("legend-18qw approval.resolved skips a requester who no longer holds an active assignment", async () => {
    const requestId = await insertApprovalRequest({
      outletId: bandung,
      requestedBy: users.lapsedApprover,
      approverRoleIds: [await roleIdOf("supervisor")],
      decided: { by: users.tenantApprover },
    });
    const event = envelope("approval.resolved", bandung, {
      chainId: requestId,
      requestId,
      sourceModule: "payment",
      actionType: "void",
      objectType: "order",
      objectId: randomUUID(),
      source: "user",
      outcome: "rejected",
      level: 1,
      requiredLevels: 1,
      requestedBy: users.lapsedApprover,
      decidedBy: users.tenantApprover,
      amountIdr: null,
    });
    expect(await resolve({ email: true, push: true }, event)).toEqual([]);
  });

  it("legend-18qw an unknown event name throws so the outbox retries and dead-letters", async () => {
    await expect(
      resolve(
        { email: true, push: true },
        envelope("order.paid", bandung, {
          totalIdr: 90000,
          receiptNumber: "LG-001",
        }),
      ),
    ).rejects.toThrow("No notification recipient rule for order.paid");
  });

  // legend-fmpgz: a platform Super Admin appoints or replaces a tenant Owner.
  // Assumptions (spec is the brief, no PRD text):
  // - "Owner aktif" means tenant-scope owner-template holders, like the
  //   support_access rules; an outlet-scope Owner is not paged.
  // - Waktu is rendered in WIB; the exact id-ID clock punctuation depends on
  //   ICU, so the time is matched as 10.30 or 10:30.
  describe("legend-fmpgz tenant_owner.changed", () => {
    // Far future on purpose: every Owner created by these tests has a
    // validFrom <= changedAt, whatever the clock says. The "appointed after
    // the change" test passes its own, past changedAt.
    const changedAt = "2030-11-09T03:30:00.000Z"; // 10:30 WIB
    const reason = "Owner lama tidak lagi bekerja di perusahaan";

    const emailOf = (id: string) => `${id}@example.test`;
    async function assignmentOf(userId: string): Promise<string> {
      const { rows } = await owner.query<{ id: string }>(
        "SELECT id FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
        [tenantId, userId],
      );
      if (!rows[0]) throw new Error("No assignment for user");
      return rows[0].id;
    }
    const ownerChanged = (payload: Record<string, unknown>) =>
      envelope("tenant_owner.changed", null, {
        changedAt,
        reason,
        ...payload,
      });
    const setEmail = (userId: string, email: string) =>
      owner.query(`UPDATE "user" SET email = $2 WHERE id = $1`, [
        userId,
        email,
      ]);
    const setName = (userId: string, name: string) =>
      owner.query(`UPDATE "user" SET name = $2 WHERE id = $1`, [userId, name]);
    /** A valid 254-character email (the maximum); unique per call (user.email is unique). */
    const longEmail = (tag: string) =>
      `${tag.repeat(58)}${randomUUID().slice(0, 6)}@${"d".repeat(63)}.${"d".repeat(63)}.${"d".repeat(57)}.com`;

    // Each test gets its own Owners; drop them so a later test does not see
    // an earlier test's still-active Owner.
    const setupUserIds: string[] = [];
    afterEach(async () => {
      await owner.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
        [tenantId, setupUserIds],
      );
      setupUserIds.length = 0;
    });

    /** Actor is a non-Owner platform admin row; an outlet Owner is the
     * "not tenant-wide" decoy; a lapsed Owner ended before the change. */
    async function setup() {
      const actor = await createUser("Dewi Super Admin", "supervisor", {
        type: "tenant",
      });
      const oldOwner = await createUser(
        "Owner lama",
        "owner",
        { type: "tenant" },
        { validFrom: "-2 hours", validUntil: "-1 minute" },
      );
      const newOwner = await createUser("Owner baru", "owner", {
        type: "tenant",
      });
      const earlierOwner = await createUser(
        "Owner dulu",
        "owner",
        { type: "tenant" },
        { validFrom: "-3 hours", validUntil: "-2 hours" },
      );
      setupUserIds.push(actor, oldOwner, newOwner, earlierOwner);
      return { actor, oldOwner, newOwner, earlierOwner };
    }

    it("legend-fmpgz replacing an Owner pages the old Owner and every active Owner once, nobody else", async () => {
      const { actor, oldOwner, newOwner, earlierOwner } = await setup();
      const recipients = await resolve(
        { email: true, push: true },
        ownerChanged({
          kind: "replaced",
          actorUserId: actor,
          newAssignmentId: await assignmentOf(newOwner),
          replacedAssignmentId: await assignmentOf(oldOwner),
        }),
      );
      const mine = ours(recipients).map((r) => r.userId);
      expect([...mine].sort()).toEqual(
        [users.tenantOwner, newOwner, oldOwner].sort(),
      );
      expect(new Set(mine).size).toBe(mine.length);
      expect(mine).not.toContain(earlierOwner);
      expect(mine).not.toContain(actor);
      expect(mine).not.toContain(users.outletOwner);
      expect(mine).not.toContain(users.tenantApprover);
      expect(mine).not.toContain(users.cashier);
      expect(mine).not.toContain(tenantBUser);
    });

    it("legend-fmpgz a first appointment pages the active Owners only (no replaced Owner)", async () => {
      const { actor, oldOwner, newOwner } = await setup();
      const recipients = await resolve(
        { email: true, push: true },
        ownerChanged({
          kind: "assigned",
          actorUserId: actor,
          newAssignmentId: await assignmentOf(newOwner),
          replacedAssignmentId: null,
        }),
      );
      const mine = ours(recipients).map((r) => r.userId);
      expect([...mine].sort()).toEqual([users.tenantOwner, newOwner].sort());
      expect(mine).not.toContain(oldOwner);
      expect(mine).not.toContain(actor);
    });

    it("legend-fmpgz the message names the actor, the accounts, the reason and the WIB time under security", async () => {
      const { actor, oldOwner, newOwner } = await setup();
      const replaced = await resolve(
        { email: true, push: true },
        ownerChanged({
          kind: "replaced",
          actorUserId: actor,
          newAssignmentId: await assignmentOf(newOwner),
          replacedAssignmentId: await assignmentOf(oldOwner),
        }),
      );
      const forOldOwner = replaced.find((r) => r.userId === oldOwner);
      expect(forOldOwner).toMatchObject({
        category: "security",
        title: "Owner diganti oleh platform",
      });
      // The actor is a name only: the platform staff email never leaks.
      expect(forOldOwner?.body).toContain("Dewi Super Admin");
      expect(forOldOwner?.body).not.toContain(emailOf(actor));
      // Owner accounts are labelled "name (email)".
      expect(forOldOwner?.body).toContain(`Owner lama (${emailOf(oldOwner)})`);
      expect(forOldOwner?.body).toContain(`Owner baru (${emailOf(newOwner)})`);
      expect(forOldOwner?.body).toContain(reason);
      expect(forOldOwner?.body).toContain("9 November 2030");
      expect(forOldOwner?.body).toMatch(/10[.:]30/);
      expect(forOldOwner?.body).toContain("WIB");
      // The same text reaches the sitting Owners.
      const sitting = replaced.find((r) => r.userId === users.tenantOwner);
      expect(sitting).toMatchObject({
        category: "security",
        title: "Owner diganti oleh platform",
        body: forOldOwner?.body,
      });

      const assigned = await resolve(
        { email: true, push: true },
        ownerChanged({
          kind: "assigned",
          actorUserId: actor,
          newAssignmentId: await assignmentOf(newOwner),
          replacedAssignmentId: null,
        }),
      );
      const first = assigned.find((r) => r.userId === newOwner);
      expect(first).toMatchObject({
        category: "security",
        title: "Owner baru ditunjuk oleh platform",
      });
      expect(first?.body).toContain("Dewi Super Admin");
      expect(first?.body).not.toContain(emailOf(actor));
      expect(first?.body).toContain(`Owner baru (${emailOf(newOwner)})`);
      expect(first?.body).toContain(reason);
      expect(first?.body).not.toContain(emailOf(oldOwner));
    });

    it("legend-fmpgz a blank actor name reads as 'tim platform' and never shows an email", async () => {
      const { actor, oldOwner, newOwner } = await setup();
      await setName(actor, "   ");
      const recipients = await resolve(
        { email: true, push: true },
        ownerChanged({
          kind: "replaced",
          actorUserId: actor,
          newAssignmentId: await assignmentOf(newOwner),
          replacedAssignmentId: await assignmentOf(oldOwner),
        }),
      );
      const body = recipients.find((r) => r.userId === oldOwner)?.body;
      expect(body).toContain("Super Admin platform tim platform mengganti");
      expect(body).not.toContain(emailOf(actor));
    });

    it("legend-fmpgz placeholder WhatsApp emails are hidden; a blank name then reads 'akun baru'", async () => {
      const { actor, oldOwner, newOwner } = await setup();
      await setEmail(oldOwner, `${randomUUID()}@wa.invalid`);
      await setEmail(newOwner, `${randomUUID()}@wa.invalid`);
      const replaced = await resolve(
        { email: true, push: true },
        ownerChanged({
          kind: "replaced",
          actorUserId: actor,
          newAssignmentId: await assignmentOf(newOwner),
          replacedAssignmentId: await assignmentOf(oldOwner),
        }),
      );
      const body = replaced.find((r) => r.userId === oldOwner)?.body;
      expect(body).toContain(
        "mengganti Owner Owner lama dengan Owner baru pada",
      );
      expect(body).not.toContain("wa.invalid");
      expect(body).not.toContain("(");

      await setName(newOwner, "");
      const assigned = await resolve(
        { email: true, push: true },
        ownerChanged({
          kind: "assigned",
          actorUserId: actor,
          newAssignmentId: await assignmentOf(newOwner),
          replacedAssignmentId: null,
        }),
      );
      const first = assigned.find((r) => r.userId === newOwner)?.body;
      expect(first).toContain("menunjuk akun baru sebagai Owner");
      expect(first).not.toContain("wa.invalid");
    });

    it("legend-fmpgz a real email with a blank name is shown as the email alone", async () => {
      const { actor, newOwner } = await setup();
      await setName(newOwner, "");
      const assigned = await resolve(
        { email: true, push: true },
        ownerChanged({
          kind: "assigned",
          actorUserId: actor,
          newAssignmentId: await assignmentOf(newOwner),
          replacedAssignmentId: null,
        }),
      );
      const body = assigned.find((r) => r.userId === newOwner)?.body;
      expect(body).toContain(`menunjuk ${emailOf(newOwner)} sebagai Owner`);
    });

    it("legend-fmpgz a 500-character reason is cut to 300 and long emails still fit the notification schema", async () => {
      const { actor, oldOwner, newOwner } = await setup();
      const oldEmail = longEmail("a");
      const newEmail = longEmail("b");
      expect(oldEmail).toHaveLength(254);
      await setEmail(oldOwner, oldEmail);
      await setEmail(newOwner, newEmail);
      const recipients = await resolve(
        { email: true, push: true },
        ownerChanged({
          kind: "replaced",
          actorUserId: actor,
          reason: "Z".repeat(500),
          newAssignmentId: await assignmentOf(newOwner),
          replacedAssignmentId: await assignmentOf(oldOwner),
        }),
      );
      const mine = ours(recipients);
      expect(mine.length).toBeGreaterThan(0);
      for (const recipient of mine) {
        expect(recipient.body.length).toBeLessThanOrEqual(1000);
        expect(recipient.body).toContain("Z".repeat(300));
        expect(recipient.body).not.toContain("Z".repeat(301));
        expect(recipient.body).toContain(oldEmail);
        expect(recipient.body).toContain(newEmail);
        const parsed = notificationSchema.shape.body.safeParse(recipient.body);
        expect(parsed.success).toBe(true);
        expect(
          notificationSchema.shape.title.safeParse(recipient.title).success,
        ).toBe(true);
      }
    });

    it("legend-fmpgz a body over 1000 characters is cut to exactly 1000 and ends with an ellipsis", async () => {
      const { actor, oldOwner, newOwner } = await setup();
      await setEmail(oldOwner, longEmail("a"));
      await setEmail(newOwner, longEmail("b"));
      await setName(oldOwner, "L".repeat(100));
      await setName(newOwner, "N".repeat(100));
      const recipients = await resolve(
        { email: true, push: true },
        ownerChanged({
          kind: "replaced",
          actorUserId: actor,
          reason: "Z".repeat(500),
          newAssignmentId: await assignmentOf(newOwner),
          replacedAssignmentId: await assignmentOf(oldOwner),
        }),
      );
      const mine = ours(recipients);
      expect(mine.length).toBeGreaterThan(0);
      for (const recipient of mine) {
        expect(recipient.body).toHaveLength(1000);
        expect(recipient.body.endsWith("…")).toBe(true);
        expect(
          notificationSchema.shape.body.safeParse(recipient.body).success,
        ).toBe(true);
      }
    });

    it("legend-fmpgz an Owner whose validFrom is after the change is not paged; one at or before it is", async () => {
      const { actor, oldOwner } = await setup();
      // The change happened two hours ago (past: unlike the other tests).
      const past = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      const before = await createUser(
        "Owner sebelum",
        "owner",
        { type: "tenant" },
        { validFrom: "-3 hours" },
      );
      const atChange = await createUser(
        "Owner tepat waktu",
        "owner",
        { type: "tenant" },
        { validFrom: "-3 hours" },
      );
      const after = await createUser(
        "Owner sesudah",
        "owner",
        { type: "tenant" },
        { validFrom: "-1 hour" },
      );
      setupUserIds.push(before, atChange, after);
      // validFrom exactly equal to changedAt still counts as "before".
      await owner.query(
        "UPDATE role_assignments SET valid_from = $3::timestamptz WHERE tenant_id = $1 AND user_id = $2",
        [tenantId, atChange, past],
      );
      const recipients = await resolve(
        { email: true, push: true },
        ownerChanged({
          kind: "replaced",
          changedAt: past,
          actorUserId: actor,
          newAssignmentId: await assignmentOf(before),
          replacedAssignmentId: await assignmentOf(oldOwner),
        }),
      );
      const mine = recipients.map((r) => r.userId);
      expect(mine).toContain(before);
      expect(mine).toContain(atChange);
      expect(mine).toContain(oldOwner);
      expect(mine).not.toContain(after);
    });

    it("legend-fmpgz another tenant's Owner is never paged and its assignment id is refused", async () => {
      const { actor, newOwner } = await setup();
      const bOwner = randomUUID();
      const bOwnerRole = randomUUID();
      await owner.query(
        `INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner B', $2)`,
        [bOwner, emailOf(bOwner)],
      );
      await owner.query(
        `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, allowed_scope_types)
         VALUES ($1, $2, 'Owner', true, 'owner', '[]'::jsonb, '["tenant"]'::jsonb)`,
        [bOwnerRole, tenantB],
      );
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, assigned_by, valid_from)
         VALUES ($1, $2, $3, 'tenant', $2, now() - interval '1 hour') RETURNING id`,
        [tenantB, bOwner, bOwnerRole],
      );
      try {
        const recipients = await resolve(
          { email: true, push: true },
          ownerChanged({
            kind: "assigned",
            actorUserId: actor,
            newAssignmentId: await assignmentOf(newOwner),
            replacedAssignmentId: null,
          }),
        );
        expect(recipients.map((r) => r.userId)).not.toContain(bOwner);
        expect(recipients.map((r) => r.userId)).not.toContain(tenantBUser);

        // An assignment id that belongs to tenant B cannot be notified from A.
        await expect(
          resolve(
            { email: true, push: true },
            ownerChanged({
              kind: "assigned",
              actorUserId: actor,
              newAssignmentId: rows[0]?.id,
              replacedAssignmentId: null,
            }),
          ),
        ).rejects.toThrow("Owner assignment not found");
        await expect(
          resolve(
            { email: true, push: true },
            ownerChanged({
              kind: "replaced",
              actorUserId: actor,
              newAssignmentId: await assignmentOf(newOwner),
              replacedAssignmentId: rows[0]?.id,
            }),
          ),
        ).rejects.toThrow("Replaced Owner assignment not found");
      } finally {
        await owner.query(
          "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
          [tenantB, bOwner],
        );
        await owner.query("DELETE FROM roles WHERE id = $1", [bOwnerRole]);
        await owner.query(`DELETE FROM "user" WHERE id = $1`, [bOwner]);
      }
    });
  });
});

describe("legend-5rgl facility_incident.raised owner fallback", () => {
  // Assumption (brief W3a, no PRD text): no active booth-operator holder on the
  // outlet pages the tenant owners instead; with no owner either, nobody is
  // paged (fail closed, empty list, no throw). Isolated tenant: the fixture
  // tenant has seeded roles that would blur an exact assertion.
  const tenantC = randomUUID();
  const brandC = randomUUID();
  const legalC = randomUUID();
  const outletC = randomUUID();
  const outletC2 = randomUUID();
  const facilityC = randomUUID();
  const boothRole = randomUUID();
  const ownerRole = randomUUID();
  const userIds: string[] = [];
  const contextC = tenantContext(tenantC);

  const makeUser = async (name: string) => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`,
      [id, name, `${id}@example.test`],
    );
    userIds.push(id);
    return id;
  };
  const assign = (
    userId: string,
    roleId: string,
    scope: { type: string; id?: string },
  ) =>
    owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, assigned_by, valid_from)
       VALUES ($1, $2, $3, $4, $5, $2, now() - interval '1 hour')`,
      [tenantC, userId, roleId, scope.type, scope.id ?? null],
    );
  const newIncident = async (outletId: string) => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO facility_incidents (id, tenant_id, outlet_id, facility_id, type, triggered_at)
       VALUES ($1, $2, $3, $4, 'panic', now())`,
      [id, tenantC, outletId, facilityC],
    );
    return id;
  };
  const page = async (incidentId: string) => {
    const event = {
      ...envelope("facility_incident.raised", outletC, {
        incidentId,
        facilityId: facilityC,
        unitId: null,
        type: "panic",
        triggeredAt: new Date().toISOString(),
        offline: false,
      }),
      tenantId: tenantC,
      outletId: outletC,
    } as ReturnType<typeof envelope>;
    return withTenant(database, contextC, (tx) =>
      createNotificationRecipientResolver({ email: true, push: true })(
        contextC,
        event,
        tx,
      ),
    );
  };

  beforeAll(async () => {
    const creator = await makeUser("Pembuat C");
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       VALUES ($1, $2, 'Owner fallback tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":2,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
      [tenantC, `adapters-5rgl-${tenantC}`, creator],
    );
    await owner.query(
      "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand 5rgl')",
      [brandC, tenantC, `adapters-5rgl-${tenantC.slice(0, 8)}`],
    );
    await owner.query(
      "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT 5rgl', false)",
      [legalC, tenantC],
    );
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
       VALUES ($1, $3, $4, $5, 'OUT-5A', 'Outlet 5A', 'Jl. A', '{}'),
              ($2, $3, $4, $5, 'OUT-5B', 'Outlet 5B', 'Jl. B', '{}')`,
      [outletC, outletC2, tenantC, brandC, legalC],
    );
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, allowed_scope_types)
       VALUES ($1, $3, 'Operator bilik', false, NULL, $4::jsonb, '["tenant","brand","outlet"]'::jsonb),
              ($2, $3, 'Owner', true, 'owner', '[]'::jsonb, '["tenant","outlet"]'::jsonb)`,
      [
        boothRole,
        ownerRole,
        tenantC,
        JSON.stringify(["facility.booth.operate"]),
      ],
    );
    await owner.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, 'Notif fallback', 'shower', 20, 10, 10, '[]', $4, $5)`,
      [
        facilityC,
        tenantC,
        outletC,
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
      ],
    );
  });

  afterEach(async () => {
    await owner.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
      tenantC,
    ]);
    await owner.query("DELETE FROM facility_incidents WHERE tenant_id = $1", [
      tenantC,
    ]);
  });

  afterAll(async () => {
    await owner.query(
      "DELETE FROM facility_operating_hours_versions WHERE facility_id = $1",
      [facilityC],
    );
    await owner.query("DELETE FROM facilities WHERE id = $1", [facilityC]);
    await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
      userIds,
    ]);
  });

  it("legend-5rgl holders on the outlet are paged and the owners are not", async () => {
    const holder = await makeUser("Operator outlet");
    const ownerUser = await makeUser("Pemilik");
    await assign(holder, boothRole, { type: "outlet", id: outletC });
    await assign(ownerUser, ownerRole, { type: "tenant" });
    const recipients = await page(await newIncident(outletC));
    expect(recipients.map((r) => r.userId)).toEqual([holder]);
    expect(recipients[0]?.category).toBe("emergency");
  });

  it("legend-5rgl a holder on another outlet is not paged; with no holder here the owners are", async () => {
    const otherHolder = await makeUser("Operator outlet lain");
    const ownerUser = await makeUser("Pemilik");
    await assign(otherHolder, boothRole, { type: "outlet", id: outletC2 });
    await assign(ownerUser, ownerRole, { type: "tenant" });
    const recipients = await page(await newIncident(outletC));
    expect(recipients.map((r) => r.userId)).toEqual([ownerUser]);
    expect(recipients[0]?.category).toBe("emergency");
  });

  it("legend-5rgl with no operator on the outlet the tenant owner is paged, an owner scoped to another outlet is not", async () => {
    const tenantOwner = await makeUser("Pemilik tenant");
    const otherOutletOwner = await makeUser("Pemilik outlet lain");
    await assign(tenantOwner, ownerRole, { type: "tenant" });
    await assign(otherOutletOwner, ownerRole, {
      type: "outlet",
      id: outletC2,
    });
    const recipients = await page(await newIncident(outletC));
    expect(recipients.map((r) => r.userId)).toEqual([tenantOwner]);
    expect(recipients[0]?.category).toBe("emergency");
  });

  it("legend-5rgl with no holder and no owner nobody is paged (fail closed)", async () => {
    const otherHolder = await makeUser("Operator outlet lain");
    await assign(otherHolder, boothRole, { type: "outlet", id: outletC2 });
    expect(await page(await newIncident(outletC))).toEqual([]);
  });
});

// Pools close once every suite in this file has finished.
afterAll(async () => {
  await owner.end();
  await appPool.end();
});
