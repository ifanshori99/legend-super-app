// WhatsApp login replies: default off, opt-in per tenant, monthly free quota
// (AUTH-03; PRD §3 F6; bead legend-dn4). Written from the slice contract in
// docs/briefs/dn4-wa-login-replies.md, before the code.
//
// Real PostgreSQL. The sender is a spy: no real WhatsApp adapter exists. Two
// throwaway tenants keep the seeded tenant untouched. Every test uses a fresh
// sender number, so the per-number AUTH-04 window never leaks between tests.
//
// Assumptions (also reported):
//  - `processInboundWhatsApp` awaits the reply before it resolves, so a
//    positive check uses `vi.waitFor` and a negative check reads right after.
//  - A "merged" reply carries the masked e-mail of the linking (surviving)
//    account, the one that is signed in and claims the number.
//  - `sendLoginReply` swallows a failing sender; the claimed slot stays used.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { maskEmail } from "@starter/shared/identity";
import { establishTenantContext } from "@starter/shared/core/server";
import type { TenantContext } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { whatsAppDigest } from "../lib/identity-digest.ts";
import { issueWhatsAppChallenge } from "../services/identity-login.service.ts";
import { processInboundWhatsApp } from "../services/identity-wa-inbound.service.ts";
import { mergedReplyText } from "../services/identity-merge.service.ts";
import { usageMonth } from "../services/platform-usage.service.ts";
import {
  claimLoginReplySlot,
  loginReplyText,
  sendLoginReply,
  type LoginReplySender,
} from "../services/wa-login-reply.service.ts";
import { agent, signUp } from "./helpers.ts";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const unique = () => randomBytes(4).toString("hex");
const digits = (length: number) =>
  Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");

const limits = {
  maxOutlets: 2,
  maxActiveEmployees: 5,
  maxDevices: 2,
  aiRequestsPerMonth: 0,
  whatsappCostCapIdr: 0,
  aiCostCapIdr: 0,
  emailCostCapIdr: 0,
};

type Tenant = { id: string; receivingNumber: string };
let tenantA: Tenant;
let tenantB: Tenant;
const senders: string[] = [];

async function createTenant(label: string): Promise<Tenant> {
  const id = randomUUID();
  const receivingNumber = `62811${digits(8)}`;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', $4, 'test')`,
    [
      id,
      `wr-${label}-${unique()}`,
      `Tenant ${label} balasan`,
      JSON.stringify(limits),
    ],
  );
  await owner.query(
    `INSERT INTO tenant_integrations (tenant_id, provider, config, credentials_encrypted, status)
     VALUES ($1, 'whatsapp', $2, 'c2VhbGVkLXRlc3Q=', 'active')`,
    [id, JSON.stringify({ vendor: "kirimdev", receivingNumber })],
  );
  return { id, receivingNumber };
}

const tenantContext = (tenantId: string): TenantContext =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });

/** A fresh sender per test: 62 + 10 digits. */
function freshSender(): string {
  const sender = `628${digits(10)}`;
  senders.push(sender);
  return sender;
}

/** Policy rows are written as the table owner: the tenant UI path is not under test here. */
async function setPolicy(
  tenantId: string,
  values: {
    enabled: boolean;
    quota?: number;
    month?: string | null;
    count?: number;
  },
) {
  await owner.query(
    `INSERT INTO wa_login_reply_policies
       (tenant_id, enabled, free_monthly_quota, replies_month, replies_this_month)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       free_monthly_quota = EXCLUDED.free_monthly_quota,
       replies_month = EXCLUDED.replies_month,
       replies_this_month = EXCLUDED.replies_this_month`,
    [
      tenantId,
      values.enabled,
      values.quota ?? 1000,
      values.month ?? null,
      values.count ?? 0,
    ],
  );
}

async function readPolicy(tenantId: string) {
  const { rows } = await owner.query<{
    enabled: boolean;
    quota: number;
    month: string | null;
    count: number;
  }>(
    `SELECT enabled, free_monthly_quota AS quota, replies_month AS month,
            replies_this_month AS count
       FROM wa_login_reply_policies WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0] ?? null;
}

const currentMonth = () => usageMonth(new Date()).month;

function makeSpy() {
  return vi.fn<LoginReplySender>(async () => undefined);
}

async function issue(
  tenant: Tenant,
  link?: { userId: string; sessionId: string },
): Promise<string> {
  const issued = await issueWhatsAppChallenge(
    tenantContext(tenant.id),
    {
      bindingNonce: randomBytes(32).toString("base64url"),
      link: link ?? null,
      ip: null,
      userAgent: null,
    },
    {},
  );
  return issued.codeFormatted;
}

function message(tenant: Tenant, sender: string, text: string) {
  return {
    eventId: `wamid.${randomUUID()}`,
    receivingNumber: tenant.receivingNumber,
    sender,
    text,
  };
}

/** A signed-in account with a real session, for number-link challenges. */
async function signedInUser() {
  const client = agent(app);
  const email = await signUp(client, "Pemilik Balasan");
  const session = await client.get("/api/auth/get-session");
  return {
    email,
    userId: session.body.user.id as string,
    sessionId: session.body.session.id as string,
  };
}

/** The older account survives a merge; make the signed-in user the older one. */
async function makeOlderThanHolder(userId: string, sender: string) {
  await owner.query('UPDATE "user" SET created_at = $2 WHERE id = $1', [
    userId,
    "2020-01-01T00:00:00Z",
  ]);
  await owner.query(
    `UPDATE "user" SET created_at = '2021-01-01T00:00:00Z'
      WHERE id = (SELECT user_id FROM user_identities
                   WHERE type = 'whatsapp' AND value_hash = $1)`,
    [await whatsAppDigest(sender)],
  );
}

beforeAll(async () => {
  [tenantA, tenantB] = await Promise.all([
    createTenant("a"),
    createTenant("b"),
  ]);
});

afterAll(async () => {
  const ids = [tenantA.id, tenantB.id];
  const hashes = await Promise.all(
    senders.map((sender) => whatsAppDigest(sender)),
  );
  const users = await owner.query<{ user_id: string }>(
    "SELECT user_id FROM user_identities WHERE type = 'whatsapp' AND value_hash = ANY($1)",
    [hashes],
  );
  const identityUserIds = users.rows.map((row) => row.user_id);
  // A merge moves the WhatsApp identity to the survivor and leaves the absorbed
  // WhatsApp-only user plus an append-only identity_merges row behind; both
  // must go, or later files sharing this database fail on the FK (legend-qodvz).
  const merges = await owner.query<{ absorbed: string }>(
    `SELECT absorbed_user_id AS absorbed FROM identity_merges
      WHERE survivor_user_id = ANY($1) OR absorbed_user_id = ANY($1)`,
    [identityUserIds],
  );
  const userIds = [
    ...new Set([...identityUserIds, ...merges.rows.map((row) => row.absorbed)]),
  ];
  await owner.query("ALTER TABLE identity_merges DISABLE TRIGGER USER");
  try {
    await owner.query(
      "DELETE FROM identity_merges WHERE survivor_user_id = ANY($1) OR absorbed_user_id = ANY($1)",
      [userIds],
    );
  } finally {
    await owner.query("ALTER TABLE identity_merges ENABLE TRIGGER USER");
  }
  await owner.query(
    "DELETE FROM wa_inbound_messages WHERE receiving_number = ANY($1)",
    [[tenantA.receivingNumber, tenantB.receivingNumber]],
  );
  await owner.query("DELETE FROM login_challenges WHERE tenant_id = ANY($1)", [
    ids,
  ]);
  await owner.query("DELETE FROM user_identities WHERE user_id = ANY($1)", [
    userIds,
  ]);
  await owner.query(
    `DELETE FROM role_assignments WHERE user_id = ANY($1) OR assigned_by = ANY($1)`,
    [userIds],
  );
  await owner.query(
    `DELETE FROM "user" WHERE id = ANY($1) AND email LIKE '%@wa.invalid'`,
    [userIds],
  );
  await owner.query(
    "DELETE FROM wa_login_reply_policies WHERE tenant_id = ANY($1)",
    [ids],
  );
  await owner.query(
    "DELETE FROM tenant_integrations WHERE tenant_id = ANY($1)",
    [ids],
  );
  await owner.query("DELETE FROM tenants WHERE id = ANY($1)", [ids]);
  await owner.end();
});

describe("loginReplyText", () => {
  it("AUTH-03 gives each kind its own non-empty wording", () => {
    const success = loginReplyText("success");
    const error = loginReplyText("error");
    expect(success.length).toBeGreaterThan(0);
    expect(error.length).toBeGreaterThan(0);
    expect(success).not.toBe(error);
    expect(loginReplyText("merged", "a***@example.com")).not.toBe(success);
    expect(loginReplyText("merged", "a***@example.com")).not.toBe(error);
  });

  it("AUTH-03 merged wording names the masked e-mail, or stays generic without one", () => {
    expect(loginReplyText("merged", "a***@example.com")).toBe(
      mergedReplyText("a***@example.com"),
    );
    expect(loginReplyText("merged", null)).toBe(mergedReplyText(null));
    expect(loginReplyText("merged")).toBe(mergedReplyText(null));
  });
});

describe("default off: nothing is sent and no quota is used", () => {
  it("AUTH-03 sends zero replies in every branch when the tenant never opted in", async () => {
    const tenant = tenantA;
    await owner.query(
      "DELETE FROM wa_login_reply_policies WHERE tenant_id = $1",
      [tenant.id],
    );
    const spy = makeSpy();
    const deps = { sendReply: spy };

    // success: a plain login.
    const sender = freshSender();
    const success = await processInboundWhatsApp(
      message(tenant, sender, `MASUK LEGEND ${await issue(tenant)}`),
      deps,
    );
    expect(success.kind).toBe("login");

    // rejected with a found challenge: the linking session is revoked.
    const revoked = await signedInUser();
    const revokedCode = await issue(tenant, revoked);
    await owner.query("DELETE FROM session WHERE id = $1", [revoked.sessionId]);
    const rejected = await processInboundWhatsApp(
      message(tenant, freshSender(), `MASUK LEGEND ${revokedCode}`),
      deps,
    );
    expect(rejected.kind).toBe("rejected");

    // rejected without a challenge, and not a login message at all.
    expect(
      (
        await processInboundWhatsApp(
          message(tenant, freshSender(), "MASUK LEGEND AAAAAA00"),
          deps,
        )
      ).kind,
    ).toBe("rejected");
    expect(
      (
        await processInboundWhatsApp(
          message(tenant, freshSender(), "halo kak"),
          deps,
        )
      ).kind,
    ).toBe("unknown");

    // merged: a WhatsApp-only owner is absorbed into the linking account.
    const mergeSender = freshSender();
    expect(
      (
        await processInboundWhatsApp(
          message(tenant, mergeSender, `MASUK LEGEND ${await issue(tenant)}`),
          deps,
        )
      ).kind,
    ).toBe("login");
    const second = await signedInUser();
    await makeOlderThanHolder(second.userId, mergeSender);
    expect(
      (
        await processInboundWhatsApp(
          message(
            tenant,
            mergeSender,
            `MASUK LEGEND ${await issue(tenant, second)}`,
          ),
          deps,
        )
      ).kind,
    ).toBe("login");

    // rate_limited: ten failed attempts, then the eleventh.
    const noisy = freshSender();
    for (let attempt = 0; attempt < 10; attempt += 1)
      await processInboundWhatsApp(
        message(
          tenant,
          noisy,
          `MASUK LEGEND AAAAAA${String(attempt).padStart(2, "0")}`,
        ),
        deps,
      );
    const limited = await processInboundWhatsApp(
      message(tenant, noisy, `MASUK LEGEND ${await issue(tenant)}`),
      deps,
    );
    expect(limited.kind).toBe("rate_limited");

    expect(spy).not.toHaveBeenCalled();
    expect(await readPolicy(tenant.id)).toBeNull();
  });

  it("AUTH-03 sends nothing when the policy row exists but is disabled", async () => {
    await setPolicy(tenantA.id, { enabled: false });
    const spy = makeSpy();
    const outcome = await processInboundWhatsApp(
      message(tenantA, freshSender(), `MASUK LEGEND ${await issue(tenantA)}`),
      { sendReply: spy },
    );
    expect(outcome.kind).toBe("login");
    expect(spy).not.toHaveBeenCalled();
    expect((await readPolicy(tenantA.id))?.count).toBe(0);
  });

  it("AUTH-03 the claim refuses without a policy row or while disabled", async () => {
    await owner.query(
      "DELETE FROM wa_login_reply_policies WHERE tenant_id = $1",
      [tenantB.id],
    );
    expect(await claimLoginReplySlot(tenantB.id, new Date())).toBe(false);
    await setPolicy(tenantB.id, { enabled: false });
    expect(await claimLoginReplySlot(tenantB.id, new Date())).toBe(false);
    expect((await readPolicy(tenantB.id))?.count).toBe(0);
  });
});

describe("opt-in: replies go out and use the monthly quota", () => {
  it("AUTH-03 replies success to the sender after a login", async () => {
    await setPolicy(tenantA.id, { enabled: true });
    const spy = makeSpy();
    const sender = freshSender();
    const incoming = message(
      tenantA,
      sender,
      `MASUK LEGEND ${await issue(tenantA)}`,
    );
    const outcome = await processInboundWhatsApp(incoming, { sendReply: spy });
    expect(outcome.kind).toBe("login");

    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith({
      tenantId: tenantA.id,
      receivingNumber: tenantA.receivingNumber,
      to: sender,
      reference: `login-reply:${incoming.eventId}`,
      text: loginReplyText("success"),
    });
    const policy = await readPolicy(tenantA.id);
    expect(policy?.count).toBe(1);
    expect(policy?.month).toBe(currentMonth());
  });

  it("AUTH-03 replies error when a found challenge is rejected", async () => {
    await setPolicy(tenantA.id, { enabled: true });
    const spy = makeSpy();
    const user = await signedInUser();
    const code = await issue(tenantA, user);
    await owner.query("DELETE FROM session WHERE id = $1", [user.sessionId]);
    const sender = freshSender();
    const incoming = message(tenantA, sender, `MASUK LEGEND ${code}`);
    const outcome = await processInboundWhatsApp(incoming, { sendReply: spy });
    expect(outcome.kind).toBe("rejected");

    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      to: sender,
      reference: `login-reply:${incoming.eventId}`,
      text: loginReplyText("error"),
    });
    expect((await readPolicy(tenantA.id))?.count).toBe(1);
  });

  it("AUTH-03 sends no error reply when the tenant is suspended", async () => {
    await setPolicy(tenantA.id, { enabled: true });
    const spy = makeSpy();
    const user = await signedInUser();
    const plainCode = await issue(tenantA);
    const linkCode = await issue(tenantA, user);
    await owner.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [
      tenantA.id,
    ]);
    try {
      for (const code of [plainCode, linkCode]) {
        const outcome = await processInboundWhatsApp(
          message(tenantA, freshSender(), `MASUK LEGEND ${code}`),
          { sendReply: spy },
        );
        expect(outcome.kind).toBe("rejected");
      }
    } finally {
      await owner.query("UPDATE tenants SET status = 'active' WHERE id = $1", [
        tenantA.id,
      ]);
    }
    expect(spy).not.toHaveBeenCalled();
    expect((await readPolicy(tenantA.id))?.count).toBe(0);
  });

  it("AUTH-03 sends no error reply when the number now belongs to another tenant", async () => {
    await setPolicy(tenantA.id, { enabled: true });
    const spy = makeSpy();
    const user = await signedInUser();
    const plainCode = await issue(tenantA);
    const linkCode = await issue(tenantA, user);
    const moved = `62811${digits(8)}`;
    const setNumber = (tenantId: string, receivingNumber: string) =>
      owner.query(
        `UPDATE tenant_integrations SET config = $2
          WHERE tenant_id = $1 AND provider = 'whatsapp'`,
        [tenantId, JSON.stringify({ vendor: "kirimdev", receivingNumber })],
      );
    // A's number moves to B; A is left with a number of its own.
    await setNumber(tenantB.id, moved);
    await setNumber(tenantA.id, tenantB.receivingNumber);
    try {
      for (const code of [plainCode, linkCode]) {
        const outcome = await processInboundWhatsApp(
          message(tenantA, freshSender(), `MASUK LEGEND ${code}`),
          { sendReply: spy },
        );
        expect(outcome.kind).toBe("rejected");
      }
    } finally {
      await setNumber(tenantA.id, tenantA.receivingNumber);
      await setNumber(tenantB.id, tenantB.receivingNumber);
    }
    expect(spy).not.toHaveBeenCalled();
    expect((await readPolicy(tenantA.id))?.count).toBe(0);
  });

  it("AUTH-03 replies merged with the masked e-mail when a number is merged", async () => {
    await setPolicy(tenantA.id, { enabled: true });
    const sender = freshSender();
    const spy = makeSpy();
    await processInboundWhatsApp(
      message(tenantA, sender, `MASUK LEGEND ${await issue(tenantA)}`),
      { sendReply: spy },
    );
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]?.[0].text).toBe(loginReplyText("success"));

    const second = await signedInUser();
    await makeOlderThanHolder(second.userId, sender);
    const incoming = message(
      tenantA,
      sender,
      `MASUK LEGEND ${await issue(tenantA, second)}`,
    );
    const outcome = await processInboundWhatsApp(incoming, { sendReply: spy });
    expect(outcome.kind).toBe("login");

    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    const text = spy.mock.calls[1]?.[0].text ?? "";
    expect(text).toBe(mergedReplyText(maskEmail(second.email)));
    expect(text).not.toContain(second.email);
    expect(text).not.toBe(loginReplyText("success"));
  });

  it("AUTH-03 sends nothing for duplicate, unknown, rate-limited or unmatched messages", async () => {
    await setPolicy(tenantA.id, { enabled: true });
    const spy = makeSpy();
    const deps = { sendReply: spy };

    // A duplicate delivery of a login replies once, not twice.
    const incoming = message(
      tenantA,
      freshSender(),
      `MASUK LEGEND ${await issue(tenantA)}`,
    );
    expect((await processInboundWhatsApp(incoming, deps)).kind).toBe("login");
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect((await processInboundWhatsApp(incoming, deps)).duplicate).toBe(true);

    // Not a login message.
    expect(
      (
        await processInboundWhatsApp(
          message(tenantA, freshSender(), "halo kak"),
          deps,
        )
      ).kind,
    ).toBe("unknown");

    // A login-shaped message with no matching challenge.
    expect(
      (
        await processInboundWhatsApp(
          message(tenantA, freshSender(), "MASUK LEGEND AAAAAA00"),
          deps,
        )
      ).kind,
    ).toBe("rejected");

    // Rate limited: ten misses, then the eleventh with a valid code.
    const noisy = freshSender();
    for (let attempt = 0; attempt < 10; attempt += 1)
      await processInboundWhatsApp(
        message(
          tenantA,
          noisy,
          `MASUK LEGEND AAAAAA${String(attempt).padStart(2, "0")}`,
        ),
        deps,
      );
    expect(
      (
        await processInboundWhatsApp(
          message(tenantA, noisy, `MASUK LEGEND ${await issue(tenantA)}`),
          deps,
        )
      ).kind,
    ).toBe("rate_limited");

    expect(spy).toHaveBeenCalledTimes(1);
    expect((await readPolicy(tenantA.id))?.count).toBe(1);
  });

  it("AUTH-03 a failing sender never changes the login outcome and the slot stays used", async () => {
    await setPolicy(tenantA.id, { enabled: true });
    const failing = vi.fn<LoginReplySender>(async () => {
      throw new Error("WhatsApp down");
    });
    const outcome = await processInboundWhatsApp(
      message(tenantA, freshSender(), `MASUK LEGEND ${await issue(tenantA)}`),
      { sendReply: failing },
    );
    expect(outcome.kind).toBe("login");
    expect(failing).toHaveBeenCalledTimes(1);
    expect((await readPolicy(tenantA.id))?.count).toBe(1);
  });

  it("AUTH-03 sendLoginReply swallows a sender failure and does not throw", async () => {
    await setPolicy(tenantA.id, { enabled: true });
    const failing = vi.fn<LoginReplySender>(async () => {
      throw new Error("WhatsApp down");
    });
    await expect(
      sendLoginReply({
        sender: failing,
        tenantId: tenantA.id,
        brandId: null,
        receivingNumber: tenantA.receivingNumber,
        to: freshSender(),
        eventId: `wamid.${randomUUID()}`,
        kind: "success",
        now: new Date(),
      }),
    ).resolves.not.toThrow();
    expect(failing).toHaveBeenCalledTimes(1);
    expect((await readPolicy(tenantA.id))?.count).toBe(1);
  });

  it("AUTH-03 without a sender nothing is claimed and no quota is used", async () => {
    await setPolicy(tenantA.id, { enabled: true, quota: 5 });
    const sent = await sendLoginReply({
      sender: undefined,
      tenantId: tenantA.id,
      brandId: null,
      receivingNumber: tenantA.receivingNumber,
      to: freshSender(),
      eventId: `wamid.${randomUUID()}`,
      kind: "success",
      now: new Date(),
    });
    expect(sent).toBe(false);
    const policy = await readPolicy(tenantA.id);
    expect(policy?.count).toBe(0);
    expect(policy?.month).toBeNull();

    // An inbound login with no `sendReply` wired behaves the same.
    const outcome = await processInboundWhatsApp(
      message(tenantA, freshSender(), `MASUK LEGEND ${await issue(tenantA)}`),
    );
    expect(outcome.kind).toBe("login");
    expect((await readPolicy(tenantA.id))?.count).toBe(0);
  });
});

describe("monthly quota", () => {
  it("AUTH-03 stops sending at the quota while logins keep working", async () => {
    await setPolicy(tenantA.id, { enabled: true, quota: 2 });
    const spy = makeSpy();
    for (let login = 0; login < 3; login += 1) {
      const outcome = await processInboundWhatsApp(
        message(tenantA, freshSender(), `MASUK LEGEND ${await issue(tenantA)}`),
        { sendReply: spy },
      );
      expect(outcome.kind).toBe("login");
    }
    expect(spy).toHaveBeenCalledTimes(2);
    const policy = await readPolicy(tenantA.id);
    expect(policy?.count).toBe(2);
    expect(policy?.quota).toBe(2);
  });

  it("AUTH-03 a quota of zero sends nothing", async () => {
    await setPolicy(tenantA.id, { enabled: true, quota: 0 });
    const spy = makeSpy();
    const outcome = await processInboundWhatsApp(
      message(tenantA, freshSender(), `MASUK LEGEND ${await issue(tenantA)}`),
      { sendReply: spy },
    );
    expect(outcome.kind).toBe("login");
    expect(spy).not.toHaveBeenCalled();
    expect(await claimLoginReplySlot(tenantA.id, new Date())).toBe(false);
  });

  it("AUTH-03 a new month starts a fresh count of one", async () => {
    // Mid-month dates so the Asia/Jakarta offset cannot move the month.
    const january = new Date("2026-01-15T05:00:00Z");
    const february = new Date("2026-02-15T05:00:00Z");
    await setPolicy(tenantA.id, {
      enabled: true,
      quota: 3,
      month: "2026-01",
      count: 3,
    });

    expect(await claimLoginReplySlot(tenantA.id, january)).toBe(false);
    expect((await readPolicy(tenantA.id))?.count).toBe(3);

    expect(await claimLoginReplySlot(tenantA.id, february)).toBe(true);
    expect(await readPolicy(tenantA.id)).toMatchObject({
      month: "2026-02",
      count: 1,
    });
    expect(await claimLoginReplySlot(tenantA.id, february)).toBe(true);
    expect(await claimLoginReplySlot(tenantA.id, february)).toBe(true);
    expect(await claimLoginReplySlot(tenantA.id, february)).toBe(false);
    expect((await readPolicy(tenantA.id))?.count).toBe(3);
  });

  it("AUTH-03 the month follows Asia/Jakarta, not UTC", async () => {
    await setPolicy(tenantA.id, {
      enabled: true,
      quota: 1,
      month: "2026-01",
      count: 1,
    });
    // 23:30 on 31 January in Jakarta: still January, quota used.
    expect(
      await claimLoginReplySlot(tenantA.id, new Date("2026-01-31T16:30:00Z")),
    ).toBe(false);
    // 00:30 on 1 February in Jakarta (still 31 January in UTC): a new month.
    expect(
      await claimLoginReplySlot(tenantA.id, new Date("2026-01-31T17:30:00Z")),
    ).toBe(true);
    expect((await readPolicy(tenantA.id))?.month).toBe("2026-02");
  });

  it("AUTH-03 parallel claims never exceed the quota", async () => {
    await setPolicy(tenantA.id, { enabled: true, quota: 5 });
    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: 25 }, () => claimLoginReplySlot(tenantA.id, now)),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
    expect((await readPolicy(tenantA.id))?.count).toBe(5);
  });

  it("AUTH-03 parallel replies send exactly the quota", async () => {
    await setPolicy(tenantA.id, { enabled: true, quota: 4 });
    const spy = makeSpy();
    await Promise.all(
      Array.from({ length: 15 }, () =>
        sendLoginReply({
          sender: spy,
          tenantId: tenantA.id,
          brandId: null,
          receivingNumber: tenantA.receivingNumber,
          to: freshSender(),
          eventId: `wamid.${randomUUID()}`,
          kind: "success",
          now: new Date(),
        }),
      ),
    );
    expect(spy).toHaveBeenCalledTimes(4);
    expect((await readPolicy(tenantA.id))?.count).toBe(4);
  });
});

describe("tenant isolation", () => {
  it("AUTH-03 one tenant's opt-in and quota never touch another's", async () => {
    await setPolicy(tenantA.id, { enabled: true, quota: 1 });
    await owner.query(
      "DELETE FROM wa_login_reply_policies WHERE tenant_id = $1",
      [tenantB.id],
    );
    const spy = makeSpy();
    const now = new Date();
    const send = (tenant: Tenant) =>
      sendLoginReply({
        sender: spy,
        tenantId: tenant.id,
        brandId: null,
        receivingNumber: tenant.receivingNumber,
        to: freshSender(),
        eventId: `wamid.${randomUUID()}`,
        kind: "success",
        now,
      });

    // B never opted in: nothing goes out, even while A sends.
    expect(await send(tenantA)).toBe(true);
    expect(await send(tenantB)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0].tenantId).toBe(tenantA.id);
    expect(await readPolicy(tenantB.id)).toBeNull();

    // A is out of quota; B opting in still gets its own full quota.
    expect(await send(tenantA)).toBe(false);
    await setPolicy(tenantB.id, { enabled: true, quota: 1 });
    expect(await send(tenantB)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[0].tenantId).toBe(tenantB.id);
    expect((await readPolicy(tenantA.id))?.count).toBe(1);
    expect((await readPolicy(tenantB.id))?.count).toBe(1);
  });
});
