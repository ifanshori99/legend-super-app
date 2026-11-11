// WhatsApp inbound proof for purposes other than sign-in (legend-lgfru,
// design docs/design/whatsapp-inbound-verification.md D-WA1..D-WA3, §5.1, §6.1).
//
// A `payslip_pin_reset` proof reuses `login_challenges`, the signed KirimDev
// webhook, its dedupe and its limits, but it never links a number, never merges
// accounts, never creates a session and never sends a reply. These tests pin
// that boundary in both directions, plus three m1 login fixes that ship with it:
// one CONFLICT no longer stops a delivery, the binding cookie is
// parameterised (login byte-identical), and a WhatsApp challenge is refused
// with 503 while KIRIM_WEBHOOK_SECRET is empty.
//
// The proof service is imported dynamically so a missing export fails each
// test on its own instead of the whole file.

// Must stay the first import: it sets TRUST_PROXY before ../app reads the env.
import {
  FILE_CLIENT_IP,
  releaseTrustedProxy,
} from "./helpers/identity-client-ip";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signKirimWebhook } from "@starter/shared/adapters";
import {
  LOGIN_CODE_TTL_MINUTES,
  MINUTE_MS,
  DAY_MS,
  PAYSLIP_PIN_PROOF_GRANT_MINUTES,
  PAYSLIP_PIN_PROOF_PER_USER_PER_HOUR,
  WA_PROOF_IDENTITY_MIN_AGE_DAYS,
  WA_PROOF_TTL_MINUTES,
} from "@starter/shared/identity";
import { CoreError } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { siteConfig } from "@starter/shared/site";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { env } from "../config/env";
import {
  cancelWhatsAppChallenge,
  issueWhatsAppChallenge,
  pollWhatsAppChallenge,
} from "../services/identity-login.service";
import { processInboundWhatsApp } from "../services/identity-wa-inbound.service";
import { browserBindingDigest, whatsAppDigest } from "../lib/identity-digest";
import * as loginBinding from "../lib/login-binding";
import { sealSecret } from "../lib/secrets";
import { resolveAdminAccount } from "../services/platform-admin-provision.service";
import { agent, originHeader, signUp } from "./helpers";
import {
  createIdentityScope,
  createIdentityTenant,
  uniqueDigits,
} from "./helpers/identity-isolation";

const SECRET = "test-kirim-webhook-secret";
// Own tenants, host, receiving numbers and senders: this file never shares rows
// with the other identity files (legend-5opkl).
const TENANT_A: string = randomUUID();
const TENANT_B = "b0a10000-0000-4000-8000-0000000000c7";
const TENANT_C = "b0a10000-0000-4000-8000-0000000000c8"; // no integration
const NUMBER_A = `62811${uniqueDigits(7)}`;
const NUMBER_B = `62811${uniqueDigits(7)}`;
const EMPLOYEE = `62812${uniqueDigits(8)}`;
const STRANGER = `62812${uniqueDigits(8)}`;
const OTHER_EMPLOYEE = `62812${uniqueDigits(8)}`;
let HOST = "";

const fileAgent = (target: Parameters<typeof agent>[0]) =>
  agent(target).set("X-Forwarded-For", FILE_CLIENT_IP);

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const app = createApp({ whatsappWebhookSecrets: [SECRET] });

const proofService = () => import("../services/identity-wa-proof.service");

function scoped(tenantId: string) {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

function nonce(): string {
  return randomBytes(32).toString("base64url");
}

type ProofSetup = {
  userId: string;
  sessionId: string;
  bindingHash: string;
  tenantId: string;
};

function employee(tenantId = TENANT_A): ProofSetup {
  return {
    userId: randomUUID(),
    sessionId: `sess-${randomUUID()}`,
    bindingHash: browserBindingDigest(nonce()),
    tenantId,
  };
}

/** Issues a payslip_pin_reset proof the way the HRIS route will. */
async function issue(
  who: ProofSetup,
  options: {
    sender?: string;
    now?: Date;
    ipHash?: string | null;
    webhookSecrets?: readonly string[];
  } = {},
) {
  const { issueWhatsAppProof } = await proofService();
  const context = scoped(who.tenantId);
  const expectedSenderHash = await whatsAppDigest(options.sender ?? EMPLOYEE);
  return withTenant(db, context, (tx) =>
    issueWhatsAppProof(tx, context, {
      purpose: "payslip_pin_reset",
      userId: who.userId,
      sessionId: who.sessionId,
      bindingHash: who.bindingHash,
      expectedSenderHash,
      ipHash: options.ipHash ?? null,
      userAgent: "uji",
      now: options.now ?? new Date(),
      webhookSecrets: options.webhookSecrets ?? [SECRET],
    }),
  );
}

function inbound(input: {
  text: string;
  sender?: string;
  receivingNumber?: string;
  eventId?: string;
}) {
  return {
    eventId: input.eventId ?? `wamid.${randomUUID()}`,
    receivingNumber: input.receivingNumber ?? NUMBER_A,
    sender: input.sender ?? EMPLOYEE,
    text: input.text,
  };
}

async function challengeRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    purpose: string;
    matched_user_id: string | null;
    session_id: string | null;
    session_issued_at: Date | null;
    completed_at: Date | null;
    consumed_at: Date | null;
  }>(
    `SELECT status, purpose, matched_user_id, session_id, session_issued_at,
            completed_at, consumed_at
       FROM login_challenges WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

async function inboundKind(eventId: string): Promise<string | undefined> {
  const { rows } = await owner.query<{ kind: string }>(
    "SELECT kind FROM wa_inbound_messages WHERE provider_message_id = $1",
    [eventId],
  );
  return rows[0]?.kind;
}

async function auditActions(challengeId: string) {
  const { rows } = await owner.query<{
    action: string;
    after: Record<string, unknown> | null;
  }>(
    `SELECT event->>'action' AS action, event->'maskedChanges'->'after' AS after
       FROM audit_logs WHERE event->>'objectId' = $1 ORDER BY created_at, id`,
    [challengeId],
  );
  return rows;
}

function countRows(
  table: "login_challenges" | "user_identities" | "identity_merges" | "session",
): Promise<number> {
  return isolation.count(table);
}

async function seedTenant(id: string, slug: string) {
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $2, 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      slug,
      JSON.stringify({
        maxOutlets: 2,
        maxActiveEmployees: 5,
        maxDevices: 2,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      // The platform tenant list parses created_by as a user id (uuid).
      randomUUID(),
    ],
  );
}

async function seedWhatsAppIntegration(
  tenantId: string,
  receivingNumber: string,
) {
  await owner.query(
    `INSERT INTO tenant_integrations (tenant_id, provider, config, credentials_encrypted, status)
     VALUES ($1, 'whatsapp', $2, 'c2VhbGVkLXRlc3Q=', 'active')
     ON CONFLICT (tenant_id, provider) WHERE outlet_id IS NULL
     DO UPDATE SET config = EXCLUDED.config, status = EXCLUDED.status`,
    [tenantId, JSON.stringify({ vendor: "kirimdev", receivingNumber })],
  );
}

const isolation = createIdentityScope(owner);
isolation.scope.tenantIds.push(TENANT_A, TENANT_B, TENANT_C);
isolation.scope.receivingNumbers.push(NUMBER_A, NUMBER_B);
isolation.scope.senders.push(EMPLOYEE, STRANGER, OTHER_EMPLOYEE);
const cleanup = isolation.cleanup;

beforeAll(async () => {
  const tenant = await createIdentityTenant(owner, "wa-proof", NUMBER_A, {
    id: TENANT_A,
  });
  HOST = tenant.hostname;
  await seedTenant(TENANT_B, "uji-bukti-wa-b");
  await seedTenant(TENANT_C, "uji-bukti-wa-c");
  await seedWhatsAppIntegration(TENANT_B, NUMBER_B);
});

beforeEach(cleanup);

afterAll(async () => {
  releaseTrustedProxy();
  await cleanup();
  await isolation.dropTenants([TENANT_A, TENANT_B, TENANT_C]);
  await owner.end();
});

describe("legend-lgfru proof issuance", () => {
  it("D-WA1 writes a payslip_pin_reset row bound to user, session, browser and sender", async () => {
    const who = employee();
    const issued = await issue(who);
    expect(issued.code).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    );
    expect(issued.waLink).toBe(
      `https://wa.me/${NUMBER_A}?text=${encodeURIComponent(`RESET PIN ${issued.code}`)}`,
    );
    expect(issued.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      WA_PROOF_TTL_MINUTES * MINUTE_MS,
    );
    expect(WA_PROOF_TTL_MINUTES).toBe(LOGIN_CODE_TTL_MINUTES);
    const { rows } = await owner.query(
      `SELECT purpose, status, tenant_id, link_user_id, link_session_id,
              browser_binding_hash, expected_sender_hash, receiving_number,
              matched_user_id, consumed_at
         FROM login_challenges WHERE id = $1`,
      [issued.challengeId],
    );
    expect(rows[0]).toEqual({
      purpose: "payslip_pin_reset",
      status: "pending",
      tenant_id: TENANT_A,
      link_user_id: who.userId,
      link_session_id: who.sessionId,
      browser_binding_hash: who.bindingHash,
      expected_sender_hash: await whatsAppDigest(EMPLOYEE),
      receiving_number: NUMBER_A,
      matched_user_id: null,
      consumed_at: null,
    });
  });

  it("D-WA6 a new proof cancels the user's pending one", async () => {
    const who = employee();
    const first = await issue(who);
    const second = await issue(who);
    expect((await challengeRow(first.challengeId)).status).toBe("cancelled");
    expect((await challengeRow(second.challengeId)).status).toBe("pending");
  });

  it(`§6.2 at most ${PAYSLIP_PIN_PROOF_PER_USER_PER_HOUR} proofs per user per hour; another user is untouched`, async () => {
    const who = employee();
    for (let i = 0; i < PAYSLIP_PIN_PROOF_PER_USER_PER_HOUR; i += 1)
      await issue(who);
    await expect(issue(who)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(issue(employee())).resolves.toBeTruthy();
    // An hour later the window has moved on.
    await expect(
      issue(who, { now: new Date(Date.now() + 61 * MINUTE_MS) }),
    ).resolves.toBeTruthy();
  });

  it("§4 proofs do not use up the per-device/IP login budget of the same browser", async () => {
    const ip = "203.0.113.71";
    const { clientIpDigest } = await import("../lib/identity-digest");
    const sharedNonce = nonce();
    const who = {
      ...employee(),
      bindingHash: browserBindingDigest(sharedNonce),
    };
    for (let i = 0; i < PAYSLIP_PIN_PROOF_PER_USER_PER_HOUR; i += 1)
      await issue(who, { ipHash: clientIpDigest(ip) });
    // Five sign-in challenges from the same browser and IP still pass.
    for (let i = 0; i < 5; i += 1)
      await issueWhatsAppChallenge(scoped(TENANT_A).tenant, {
        bindingNonce: sharedNonce,
        ip,
        userAgent: "uji",
      });
  });

  it("§7 503 when KIRIM_WEBHOOK_SECRET is empty", async () => {
    await expect(
      issue(employee(), { webhookSecrets: [] }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(await countRows("login_challenges")).toBe(0);
  });

  it("a suspended tenant issues no proof, the same refusal as the sign-in path", async () => {
    await owner.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [
      TENANT_B,
    ]);
    try {
      await expect(issue(employee(TENANT_B))).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        message: "Tenant ini sedang tidak aktif.",
      });
      await expect(
        issueWhatsAppChallenge(scoped(TENANT_B).tenant, {
          bindingNonce: nonce(),
          ip: null,
          userAgent: null,
        }),
      ).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        message: "Tenant ini sedang tidak aktif.",
      });
      expect(await countRows("login_challenges")).toBe(0);
    } finally {
      await owner.query("UPDATE tenants SET status = 'active' WHERE id = $1", [
        TENANT_B,
      ]);
    }
  });

  it("§7 503 when the tenant has no active whatsapp integration", async () => {
    await expect(issue(employee(TENANT_C))).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
});

describe("legend-lgfru webhook completes a proof and nothing else", () => {
  it("D-WA1 RESET PIN from the expected sender completes it without link, merge, session or reply", async () => {
    const who = employee();
    const issued = await issue(who);
    const identitiesBefore = await countRows("user_identities");
    const sessionsBefore = await countRows("session");
    const mergesBefore = await countRows("identity_merges");
    const message = inbound({ text: `RESET PIN ${issued.code}` });
    const sent: unknown[] = [];
    const outcome = await processInboundWhatsApp(message, {
      resolveAccount: () => {
        throw new Error("a proof must never resolve an account");
      },
      sendReply: async (input) => {
        sent.push(input);
      },
    });
    expect(outcome.kind).toBe("proof");
    expect(await inboundKind(message.eventId)).toBe("proof");
    const row = await challengeRow(issued.challengeId);
    expect(row.status).toBe("completed");
    expect(row.matched_user_id).toBeNull();
    expect(row.session_id).toBeNull();
    expect(row.session_issued_at).toBeNull();
    expect(row.completed_at).not.toBeNull();
    expect(await countRows("user_identities")).toBe(identitiesBefore);
    expect(await countRows("session")).toBe(sessionsBefore);
    expect(await countRows("identity_merges")).toBe(mergesBefore);
    expect(sent).toEqual([]);
    const audit = await auditActions(issued.challengeId);
    expect(audit.map((entry) => entry.action)).toContain(
      "payslip_pin.wa_proof_verified",
    );
    expect(JSON.stringify(audit)).not.toContain(EMPLOYEE);
  });

  it("D-WA2 a proof code sent as MASUK is refused and stays pending", async () => {
    const issued = await issue(employee());
    const message = inbound({ text: `MASUK LEGEND ${issued.code}` });
    const outcome = await processInboundWhatsApp(message, {
      resolveAccount: () => {
        throw new Error("a proof must never resolve an account");
      },
    });
    expect(outcome.kind).toBe("rejected");
    expect((await challengeRow(issued.challengeId)).status).toBe("pending");
    expect(await countRows("user_identities")).toBe(0);
    const audit = await auditActions(issued.challengeId);
    expect(audit).toContainEqual(
      expect.objectContaining({
        action: "payslip_pin.wa_proof_rejected",
        after: expect.objectContaining({ cause: "purpose_mismatch" }),
      }),
    );
  });

  it("D-WA2 a login code sent as RESET PIN is refused and stays pending", async () => {
    const issued = await issueWhatsAppChallenge(
      scoped(TENANT_A).tenant,
      { bindingNonce: nonce(), ip: null, userAgent: null },
      { generateCode: () => "K7Q4M2XD" },
    );
    const message = inbound({ text: "RESET PIN K7Q4-M2XD" });
    const outcome = await processInboundWhatsApp(message, {
      resolveAccount: () => {
        throw new Error("a refused message must not resolve an account");
      },
    });
    expect(outcome.kind).toBe("rejected");
    const row = await challengeRow(issued.challenge.id);
    expect(row.status).toBe("pending");
    expect(row.matched_user_id).toBeNull();
  });

  it("D-WA3 a different sender is refused, the proof stays pending, the cause is audited", async () => {
    const issued = await issue(employee());
    const message = inbound({
      text: `RESET PIN ${issued.code}`,
      sender: STRANGER,
    });
    const outcome = await processInboundWhatsApp(message);
    expect(outcome.kind).toBe("rejected");
    expect((await challengeRow(issued.challengeId)).status).toBe("pending");
    const audit = await auditActions(issued.challengeId);
    expect(audit).toContainEqual(
      expect.objectContaining({
        action: "payslip_pin.wa_proof_rejected",
        after: expect.objectContaining({ cause: "sender_mismatch" }),
      }),
    );
    expect(JSON.stringify(audit)).not.toContain(STRANGER);
    // The right sender afterwards still completes it.
    const retry = await processInboundWhatsApp(
      inbound({ text: `RESET PIN ${issued.code}` }),
    );
    expect(retry.kind).toBe("proof");
  });

  it("AUTH-02 a message received on another tenant's number does not complete it", async () => {
    const issued = await issue(employee());
    const outcome = await processInboundWhatsApp(
      inbound({ text: `RESET PIN ${issued.code}`, receivingNumber: NUMBER_B }),
    );
    expect(outcome.kind).toBe("rejected");
    expect((await challengeRow(issued.challengeId)).status).toBe("pending");
  });

  it("AUTH-02 a replay is a duplicate and a second message cannot complete twice", async () => {
    const issued = await issue(employee());
    const message = inbound({ text: `RESET PIN ${issued.code}` });
    expect((await processInboundWhatsApp(message)).kind).toBe("proof");
    const replay = await processInboundWhatsApp(message);
    expect(replay.duplicate).toBe(true);
    const again = await processInboundWhatsApp(
      inbound({ text: `RESET PIN ${issued.code}` }),
    );
    expect(again.kind).toBe("rejected");
    const audit = await auditActions(issued.challengeId);
    expect(
      audit.filter((entry) => entry.action === "payslip_pin.wa_proof_verified"),
    ).toHaveLength(1);
  });

  it("AUTH-01 an expired proof is not completed", async () => {
    const issued = await issue(employee(), {
      now: new Date(Date.now() - (WA_PROOF_TTL_MINUTES + 1) * MINUTE_MS),
    });
    const outcome = await processInboundWhatsApp(
      inbound({ text: `RESET PIN ${issued.code}` }),
    );
    expect(outcome.kind).toBe("rejected");
    expect((await challengeRow(issued.challengeId)).status).toBe("expired");
  });

  it("§5.1 the database refuses a proof row with a matched user or a session", async () => {
    const issued = await issue(employee());
    await owner.query(
      "UPDATE login_challenges SET status = 'completed', completed_at = now() WHERE id = $1",
      [issued.challengeId],
    );
    await expect(
      owner.query(
        "UPDATE login_challenges SET matched_user_id = 'someone' WHERE id = $1",
        [issued.challengeId],
      ),
    ).rejects.toThrow(/login_challenges_proof_shape_check/);
    await expect(
      owner.query(
        "UPDATE login_challenges SET session_issued_at = now() WHERE id = $1",
        [issued.challengeId],
      ),
    ).rejects.toThrow(/login_challenges_proof_shape_check/);
    await expect(
      owner.query(
        "UPDATE login_challenges SET purpose = 'unknown' WHERE id = $1",
        [issued.challengeId],
      ),
    ).rejects.toThrow(/login_challenges_purpose_check/);
    // consumed_at only on a completed proof.
    const pending = await issue(employee());
    await expect(
      owner.query(
        "UPDATE login_challenges SET consumed_at = now() WHERE id = $1",
        [pending.challengeId],
      ),
    ).rejects.toThrow(/login_challenges_consumed_check/);
  });
});

describe("legend-lgfru login paths ignore proof rows", () => {
  it("D-WA1 polling a proof row through the login endpoint never issues a session", async () => {
    const bindingNonce = nonce();
    const who = {
      ...employee(),
      bindingHash: browserBindingDigest(bindingNonce),
    };
    const issued = await issue(who);
    await processInboundWhatsApp(inbound({ text: `RESET PIN ${issued.code}` }));
    const sessionsBefore = await countRows("session");
    await expect(
      pollWhatsAppChallenge(issued.challengeId, {
        bindingNonce,
        link: { userId: who.userId, sessionId: who.sessionId },
        ip: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      pollWhatsAppChallenge(issued.challengeId, {
        bindingNonce,
        link: null,
        ip: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await countRows("session")).toBe(sessionsBefore);
    const row = await challengeRow(issued.challengeId);
    expect(row.session_issued_at).toBeNull();
    expect(row.status).toBe("completed");
  });

  it("D-WA1 the login cancel endpoint cannot cancel a proof row", async () => {
    const bindingNonce = nonce();
    const who = {
      ...employee(),
      bindingHash: browserBindingDigest(bindingNonce),
    };
    const issued = await issue(who);
    await expect(
      cancelWhatsAppChallenge(issued.challengeId, bindingNonce),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await challengeRow(issued.challengeId)).status).toBe("pending");
  });
});

describe("legend-lgfru read, consume and cancel", () => {
  async function verifiedProof(who = employee()) {
    const issued = await issue(who);
    const outcome = await processInboundWhatsApp(
      inbound({ text: `RESET PIN ${issued.code}` }),
    );
    expect(outcome.kind).toBe("proof");
    return { who, issued };
  }

  function bound(who: ProofSetup, challengeId: string, now = new Date()) {
    return {
      challengeId,
      purpose: "payslip_pin_reset" as const,
      tenantId: who.tenantId,
      userId: who.userId,
      sessionId: who.sessionId,
      bindingHash: who.bindingHash,
      now,
    };
  }

  async function inTenant<T>(
    tenantId: string,
    run: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>,
  ) {
    return withTenant(db, scoped(tenantId), run);
  }

  it("§6.1 read reports pending, verified with a grant window, then used", async () => {
    const svc = await proofService();
    const who = employee();
    const issued = await issue(who);
    const pending = await inTenant(TENANT_A, (tx) =>
      svc.readWhatsAppProof(tx, bound(who, issued.challengeId)),
    );
    expect(pending).toMatchObject({ status: "pending", grantExpiresAt: null });
    await processInboundWhatsApp(inbound({ text: `RESET PIN ${issued.code}` }));
    const verified = await inTenant(TENANT_A, (tx) =>
      svc.readWhatsAppProof(tx, bound(who, issued.challengeId)),
    );
    expect(verified?.status).toBe("verified");
    const completedAt = (await challengeRow(issued.challengeId)).completed_at!;
    expect(verified?.grantExpiresAt?.getTime()).toBe(
      completedAt.getTime() + PAYSLIP_PIN_PROOF_GRANT_MINUTES * MINUTE_MS,
    );
    expect(
      await inTenant(TENANT_A, (tx) =>
        svc.consumeWhatsAppProof(tx, bound(who, issued.challengeId)),
      ),
    ).toBe(true);
    const used = await inTenant(TENANT_A, (tx) =>
      svc.readWhatsAppProof(tx, bound(who, issued.challengeId)),
    );
    expect(used?.status).toBe("used");
  });

  it("§6.1 read answers null for any binding mismatch", async () => {
    const svc = await proofService();
    const who = employee();
    const issued = await issue(who);
    const base = bound(who, issued.challengeId);
    for (const wrong of [
      { ...base, bindingHash: browserBindingDigest(nonce()) },
      { ...base, sessionId: "other-session" },
      { ...base, userId: randomUUID() },
      { ...base, tenantId: TENANT_B },
      { ...base, challengeId: randomUUID() },
    ])
      expect(
        await inTenant(TENANT_A, (tx) => svc.readWhatsAppProof(tx, wrong)),
      ).toBeNull();
  });

  it("§6.1 read reports expired after the code window", async () => {
    const svc = await proofService();
    const who = employee();
    const issued = await issue(who);
    const later = new Date(Date.now() + (WA_PROOF_TTL_MINUTES + 1) * MINUTE_MS);
    const view = await inTenant(TENANT_A, (tx) =>
      svc.readWhatsAppProof(tx, bound(who, issued.challengeId, later)),
    );
    expect(view?.status).toBe("expired");
  });

  it("§3 consume is single use and checks every binding and the grant window", async () => {
    const svc = await proofService();
    const { who, issued } = await verifiedProof();
    const base = bound(who, issued.challengeId);
    for (const wrong of [
      { ...base, bindingHash: browserBindingDigest(nonce()) },
      { ...base, sessionId: "other-session" },
      { ...base, userId: randomUUID() },
      { ...base, tenantId: TENANT_B },
    ])
      expect(
        await inTenant(TENANT_A, (tx) => svc.consumeWhatsAppProof(tx, wrong)),
      ).toBe(false);
    const late = {
      ...base,
      now: new Date(
        Date.now() + (PAYSLIP_PIN_PROOF_GRANT_MINUTES + 1) * MINUTE_MS,
      ),
    };
    expect(
      await inTenant(TENANT_A, (tx) => svc.consumeWhatsAppProof(tx, late)),
    ).toBe(false);
    expect(
      await inTenant(TENANT_A, (tx) => svc.consumeWhatsAppProof(tx, base)),
    ).toBe(true);
    expect(
      await inTenant(TENANT_A, (tx) => svc.consumeWhatsAppProof(tx, base)),
    ).toBe(false);
    expect((await challengeRow(issued.challengeId)).consumed_at).not.toBeNull();
  });

  it("§3 a pending proof cannot be consumed", async () => {
    const svc = await proofService();
    const who = employee();
    const issued = await issue(who);
    expect(
      await inTenant(TENANT_A, (tx) =>
        svc.consumeWhatsAppProof(tx, bound(who, issued.challengeId)),
      ),
    ).toBe(false);
  });

  it("§6.1 cancel by the owner; a foreign session gets NOT_FOUND", async () => {
    const svc = await proofService();
    const who = employee();
    const issued = await issue(who);
    const { bindingHash: _ignored, ...cancelInput } = bound(
      who,
      issued.challengeId,
    );
    void _ignored;
    await expect(
      inTenant(TENANT_A, (tx) =>
        svc.cancelWhatsAppProof(tx, { ...cancelInput, sessionId: "other" }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await challengeRow(issued.challengeId)).status).toBe("pending");
    await inTenant(TENANT_A, (tx) => svc.cancelWhatsAppProof(tx, cancelInput));
    expect((await challengeRow(issued.challengeId)).status).toBe("cancelled");
  });

  it("§3 cancelOpen cancels pending and verified-unused proofs, never a used one", async () => {
    const svc = await proofService();
    const who = employee();
    // A used proof first.
    const { issued: used } = await verifiedProof(who);
    expect(
      await inTenant(TENANT_A, (tx) =>
        svc.consumeWhatsAppProof(tx, bound(who, used.challengeId)),
      ),
    ).toBe(true);
    // A verified, unused one.
    const { issued: verified } = await verifiedProof(who);
    // A pending one (issuing does not cancel the verified one).
    const pending = await issue(who);
    // Another user's proof is untouched.
    const other = employee();
    const foreign = await issue(other);
    const cancelled = await inTenant(TENANT_A, (tx) =>
      svc.cancelOpenWhatsAppProofs(tx, {
        purpose: "payslip_pin_reset",
        tenantId: TENANT_A,
        userId: who.userId,
        now: new Date(),
      }),
    );
    expect(cancelled).toBe(2);
    expect((await challengeRow(verified.challengeId)).status).toBe("cancelled");
    expect((await challengeRow(pending.challengeId)).status).toBe("cancelled");
    expect((await challengeRow(used.challengeId)).status).toBe("completed");
    expect((await challengeRow(foreign.challengeId)).status).toBe("pending");
    expect(
      await inTenant(TENANT_A, (tx) =>
        svc.consumeWhatsAppProof(tx, bound(who, verified.challengeId)),
      ),
    ).toBe(false);
  });
});

describe("legend-lgfru D-WA3 identity age", () => {
  async function insertIdentity(input: {
    userId: string;
    number: string;
    verified: boolean;
    linkedAt: Date;
  }) {
    const digest = await whatsAppDigest(input.number);
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO user_identities (user_id, type, value_hash, value_encrypted, verified_at, linked_at)
       VALUES ($1, 'whatsapp', $2, $3, $4, $5) RETURNING id`,
      [
        input.userId,
        digest,
        sealSecret(input.number, `user_identity:whatsapp:${digest}`),
        input.verified ? input.linkedAt : null,
        input.linkedAt,
      ],
    );
    return rows[0]!.id;
  }

  async function linkedAt(id: string): Promise<Date> {
    const { rows } = await owner.query<{ linked_at: Date }>(
      "SELECT linked_at FROM user_identities WHERE id = $1",
      [id],
    );
    return rows[0]!.linked_at;
  }

  it("§5.1 the trigger refreshes linked_at when the owner or verified_at changes (merge included)", async () => {
    const old = new Date(Date.now() - 30 * DAY_MS);
    const id = await insertIdentity({
      userId: randomUUID(),
      number: EMPLOYEE,
      verified: true,
      linkedAt: old,
    });
    // Unrelated change: untouched.
    await owner.query(
      "UPDATE user_identities SET is_primary = true WHERE id = $1",
      [id],
    );
    expect((await linkedAt(id)).getTime()).toBe(old.getTime());
    // Merge moves the identity with UPDATE user_id (identity-merge.service).
    await owner.query("UPDATE user_identities SET user_id = $2 WHERE id = $1", [
      id,
      randomUUID(),
    ]);
    expect(Date.now() - (await linkedAt(id)).getTime()).toBeLessThan(MINUTE_MS);
    // verified_at changing refreshes it as well.
    await owner.query(
      "UPDATE user_identities SET linked_at = $2 WHERE id = $1",
      [id, old],
    );
    await owner.query(
      "UPDATE user_identities SET verified_at = now() WHERE id = $1",
      [id],
    );
    expect(Date.now() - (await linkedAt(id)).getTime()).toBeLessThan(MINUTE_MS);
  });

  it(`D-WA3 eligible only when verified and linked at least WA_PROOF_IDENTITY_MIN_AGE_DAYS (${WA_PROOF_IDENTITY_MIN_AGE_DAYS}) days ago`, async () => {
    const svc = await proofService();
    const now = new Date();
    const minAge = WA_PROOF_IDENTITY_MIN_AGE_DAYS * DAY_MS;
    const lookup = (userId: string) =>
      withTenant(db, scoped(TENANT_A), (tx) =>
        svc.findWhatsAppProofIdentity(tx, { userId, now }),
      );

    const justOver = randomUUID();
    await insertIdentity({
      userId: justOver,
      number: EMPLOYEE,
      verified: true,
      linkedAt: new Date(now.getTime() - minAge - MINUTE_MS),
    });
    expect(await lookup(justOver)).toEqual({
      valueHash: await whatsAppDigest(EMPLOYEE),
      senderHint: EMPLOYEE.slice(-4),
    });

    const justUnder = randomUUID();
    await insertIdentity({
      userId: justUnder,
      number: STRANGER,
      verified: true,
      linkedAt: new Date(now.getTime() - minAge + MINUTE_MS),
    });
    expect(await lookup(justUnder)).toBeNull();

    const unverified = randomUUID();
    await insertIdentity({
      userId: unverified,
      number: OTHER_EMPLOYEE,
      verified: false,
      linkedAt: new Date(now.getTime() - 2 * minAge),
    });
    expect(await lookup(unverified)).toBeNull();
    expect(await lookup(randomUUID())).toBeNull();
  });

  /** Links `number` to `userId`'s session through the real link path. */
  async function linkThroughWebhook(userId: string, sessionId: string) {
    const issued = await issueWhatsAppChallenge(
      scoped(TENANT_A).tenant,
      {
        bindingNonce: nonce(),
        link: { userId, sessionId },
        ip: null,
        userAgent: null,
      },
      { generateCode: () => "K7Q4M2XD" },
    );
    const outcome = await processInboundWhatsApp(
      inbound({ text: "MASUK LEGEND K7Q4-M2XD", sender: EMPLOYEE }),
      { sendReply: async () => undefined },
    );
    return { issued, outcome };
  }

  const eligibility = (userId: string) =>
    proofService().then((svc) =>
      withTenant(db, scoped(TENANT_A), (tx) =>
        svc.findWhatsAppProofIdentity(tx, { userId, now: new Date() }),
      ),
    );

  it("D-WA3 a link that absorbs the number's account resets linked_at through the real merge path", async () => {
    // V: a WhatsApp-only account made by a plain sign-in, number verified 30
    // days ago (the age is the setup; the merge below is the code under test).
    await issueWhatsAppChallenge(
      scoped(TENANT_A).tenant,
      { bindingNonce: nonce(), ip: null, userAgent: null },
      { generateCode: () => "A1B2C3D4" },
    );
    const login = await processInboundWhatsApp(
      inbound({ text: "MASUK LEGEND A1B2-C3D4", sender: EMPLOYEE }),
      { sendReply: async () => undefined },
    );
    expect(login.kind).toBe("login");
    const { rows: held } = await owner.query<{ user_id: string }>(
      "SELECT user_id FROM user_identities WHERE type = 'whatsapp' AND value_hash = $1",
      [await whatsAppDigest(EMPLOYEE)],
    );
    expect(held).toHaveLength(1);
    const absorbedUserId = held[0]!.user_id;
    await owner.query(
      "UPDATE user_identities SET linked_at = $1 WHERE user_id = $2",
      [new Date(Date.now() - 30 * DAY_MS), absorbedUserId],
    );
    expect(await eligibility(absorbedUserId)).not.toBeNull();

    // U: signed in and OLDER than V, so U survives and V's identity moves.
    const browser = fileAgent(app).host(HOST);
    await signUp(browser);
    const current = await browser.get("/api/auth/get-session");
    const userId: string = current.body.user.id;
    isolation.scope.userIds.push(userId);
    await owner.query('UPDATE "user" SET created_at = $2 WHERE id = $1', [
      userId,
      new Date(Date.now() - 400 * DAY_MS),
    ]);
    const { outcome } = await linkThroughWebhook(
      userId,
      current.body.session.id,
    );
    expect(outcome.kind).toBe("login");
    const { rows: moved } = await owner.query<{ user_id: string }>(
      "SELECT user_id FROM user_identities WHERE type = 'whatsapp' AND value_hash = $1",
      [await whatsAppDigest(EMPLOYEE)],
    );
    expect(moved).toEqual([{ user_id: userId }]);
    expect(await countRows("identity_merges")).toBeGreaterThan(0);

    // The identity is the old one, but the link counts as new from the merge.
    expect(await eligibility(userId)).toBeNull();
  });

  it("D-WA3 completeLink verifying an unverified number from platform-admin provisioning resets linked_at", async () => {
    const admin = await db.transaction((tx) =>
      resolveAdminAccount(
        tx,
        { name: "Admin Pertama", whatsapp: EMPLOYEE, email: null },
        new Date(Date.now() - 30 * DAY_MS),
      ),
    );
    expect(admin.account).toBe("invited");
    // Provisioning wrote the number unverified, dated 30 days ago.
    const { rows } = await owner.query<{ verified_at: Date | null }>(
      "SELECT verified_at FROM user_identities WHERE user_id = $1",
      [admin.userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verified_at).toBeNull();
    await owner.query(
      "UPDATE user_identities SET linked_at = $1 WHERE user_id = $2",
      [new Date(Date.now() - 30 * DAY_MS), admin.userId],
    );
    expect(await eligibility(admin.userId)).toBeNull(); // unverified

    // The admin signs in (a session row) and proves the number by linking it.
    const sessionId = `sess-${randomUUID()}`;
    await owner.query(
      `INSERT INTO session (id, token, user_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 day')`,
      [sessionId, `tok-${randomUUID()}`, admin.userId],
    );
    const { outcome } = await linkThroughWebhook(admin.userId, sessionId);
    expect(outcome.kind).toBe("login");
    const { rows: after } = await owner.query<{ verified_at: Date | null }>(
      "SELECT verified_at FROM user_identities WHERE user_id = $1",
      [admin.userId],
    );
    expect(after[0]!.verified_at).not.toBeNull();

    // Verified now, but only now: not eligible until the minimum age passes.
    expect(await eligibility(admin.userId)).toBeNull();
  });
});

describe("legend-lgfru m1 login fixes", () => {
  function kirimPayload(
    messages: Array<{ id: string; from: string; text: string }>,
  ) {
    return JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-test",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: NUMBER_A },
                messages: messages.map((message) => ({
                  id: message.id,
                  from: message.from,
                  type: "text",
                  text: { body: message.text },
                })),
              },
            },
          ],
        },
      ],
    });
  }

  async function postWebhook(body: string) {
    const signature = await signKirimWebhook({ rawBody: body, secret: SECRET });
    return fileAgent(app)
      .host(HOST)
      .post("/api/webhooks/whatsapp")
      .set("Content-Type", "application/json")
      .set("X-Kirim-Signature", signature)
      .set("X-Kirim-Event-Id", "evt-" + randomUUID())
      .send(body);
  }

  it("(a) one CONFLICT message does not stop the rest of the delivery; answers 200", async () => {
    const reused = `wamid.${randomUUID()}`;
    const first = await postWebhook(
      kirimPayload([{ id: reused, from: STRANGER, text: "halo" }]),
    );
    expect(first.status).toBe(200);
    // A plain sign-in challenge: this is the m1 login path, no proof needed.
    const issued = await issueWhatsAppChallenge(
      scoped(TENANT_A).tenant,
      { bindingNonce: nonce(), ip: null, userAgent: null },
      { generateCode: () => "K7Q4M2XD" },
    );
    const later = `wamid.${randomUUID()}`;
    const res = await postWebhook(
      kirimPayload([
        // Same id, different content: a CONFLICT for this one message only.
        { id: reused, from: STRANGER, text: "halo lagi" },
        { id: later, from: EMPLOYEE, text: "MASUK LEGEND K7Q4-M2XD" },
      ]),
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      received: 2,
      completed: 1,
      conflicts: 1,
    });
    expect(await inboundKind(later)).toBe("login");
    expect((await challengeRow(issued.challenge.id)).status).toBe("completed");
  });

  it("(b) login binding cookie stays byte-identical; the pin-reset cookie has its own name, path and label", async () => {
    const value = nonce();
    const cookies: Array<{
      name: string;
      value: string;
      options: Record<string, unknown>;
    }> = [];
    const res = {
      cookie(
        name: string,
        cookieValue: string,
        options: Record<string, unknown>,
      ) {
        cookies.push({ name, value: cookieValue, options });
        return this;
      },
    } as unknown as Response;
    const loginSignature = createHmac("sha256", env.BETTER_AUTH_SECRET)
      .update(`login-binding\u0000${value}`, "utf8")
      .digest("base64url");

    loginBinding.setBindingCookie(res, value, 360);
    expect(cookies[0]).toMatchObject({
      name: `${siteConfig.id}.login_binding`,
      value: `${value}.${loginSignature}`,
      options: {
        path: "/api/auth/login-challenges",
        maxAge: 360_000,
        httpOnly: true,
      },
    });
    expect(loginBinding.BINDING_COOKIE).toBe(`${siteConfig.id}.login_binding`);
    expect(loginBinding.bindingDigestOf(value)).toBe(
      browserBindingDigest(value),
    );

    const pin = (loginBinding as Record<string, unknown>)
      .PIN_RESET_BINDING as Parameters<typeof loginBinding.setBindingCookie>[3];
    expect(pin).toBeDefined();
    loginBinding.setBindingCookie(res, value, 960, pin);
    expect(cookies[1]).toMatchObject({
      name: `${siteConfig.id}.pin_reset_binding`,
      options: { path: "/api/hris/me/payslip-pin/reset-wa", maxAge: 960_000 },
    });
    expect(cookies[1]!.value).not.toBe(cookies[0]!.value);
    expect(loginBinding.bindingDigestOf(value, pin)).not.toBe(
      loginBinding.bindingDigestOf(value),
    );

    const requestWith = (header: string) =>
      ({
        get: (name: string) => (name === "cookie" ? header : undefined),
      }) as unknown as Request;
    // Each reader only accepts its own cookie.
    const pinCookie = `${cookies[1]!.name}=${encodeURIComponent(cookies[1]!.value)}`;
    const loginCookie = `${cookies[0]!.name}=${encodeURIComponent(cookies[0]!.value)}`;
    expect(loginBinding.readBindingNonce(requestWith(pinCookie), pin)).toBe(
      value,
    );
    expect(loginBinding.readBindingNonce(requestWith(loginCookie))).toBe(value);
    expect(loginBinding.readBindingNonce(requestWith(pinCookie))).toBeNull();
    // A login cookie value replayed under the pin-reset name fails its label.
    const forged = `${cookies[1]!.name}=${encodeURIComponent(cookies[0]!.value)}`;
    expect(loginBinding.readBindingNonce(requestWith(forged), pin)).toBeNull();
  });

  it("(c) a WhatsApp login challenge is refused with 503 while KIRIM_WEBHOOK_SECRET is empty", async () => {
    const closed = createApp({ whatsappWebhookSecrets: [] });
    const res = await agent(closed)
      .host(HOST)
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
    await expect(
      issueWhatsAppChallenge(
        scoped(TENANT_A).tenant,
        { bindingNonce: nonce(), ip: null, userAgent: null },
        { webhookSecrets: [] } as Parameters<typeof issueWhatsAppChallenge>[2],
      ),
    ).rejects.toBeInstanceOf(CoreError);
    expect(await countRows("login_challenges")).toBe(0);
    // With a secret the same request still works.
    const open = await fileAgent(app)
      .host(HOST)
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    expect(open.status).toBe(201);
  });
});

// The full parser table lives in tests/wa-proof-parser.test.mjs (root suite);
// this copy lets the targeted API run prove it too.
describe("legend-lgfru shared parser", () => {
  it("D-WA2 reads the purpose from the command word", async () => {
    const shared = (await import("@starter/shared/identity")) as Record<
      string,
      unknown
    >;
    const parse = shared.whatsAppProofFromMessage as (
      text: string,
    ) => { purpose: string; code: string } | null;
    expect(typeof parse).toBe("function");
    expect(parse("RESET PIN K7Q4-M2XD")).toEqual({
      purpose: "payslip_pin_reset",
      code: "K7Q4M2XD",
    });
    expect(parse("MASUK LEGEND K7Q4-M2XD")).toEqual({
      purpose: "sign_in",
      code: "K7Q4M2XD",
    });
    expect(parse("RESET PIN LEGEND K7Q4-M2XD")).toBeNull();
    expect(WA_PROOF_IDENTITY_MIN_AGE_DAYS).toBe(3);
  });
});
