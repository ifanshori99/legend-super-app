// WhatsApp inbound: the live channel is checked FIRST (legend-3hb1n, AUTH-02).
// Written from docs/briefs/legend-52tdq.md and the bead text, before the fix.
//
// A challenge issued while the tenant had a live channel keeps its stored
// receiving number (TTL 5 minutes). If the platform sender mapping is gone or
// points elsewhere when the inbound message arrives, the message must be
// rejected BEFORE anything is written for the claiming tenant:
//  - no account is auto-created (the account store uses its own connection, so
//    a late check cannot roll it back);
//  - no audit row (rejected / purpose-mismatch) lands in the claiming tenant's
//    audit trail;
//  - the challenge stays pending.
// A live, matching channel keeps working (regression).
//
// Assumptions (also reported):
//  - "Live channel" means the tenant-wide row of `kirimdev_sender_mappings`
//    whose phone_number_id equals the number the challenge was routed by (the
//    same comparison the completion step makes). A removed mapping and a
//    mapping re-pointed to another number are both refused before any
//    account is created. Only the removed mapping writes no audit; with a
//    re-pointed live channel the tenant's own rejected audit stays (wq3f).
//  - The outcome kind for both is "rejected", as in wa-inbound-sender-mapping.
//  - Audit rows are counted per tenant in `audit_logs` before and after the
//    inbound message, so any audit the issue step writes is not counted.

// Must stay the first import: it sets TRUST_PROXY before ../app reads the env.
import { releaseTrustedProxy } from "./helpers/identity-client-ip";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
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
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { browserBindingDigest, whatsAppDigest } from "../lib/identity-digest";
import { issueWhatsAppChallenge } from "../services/identity-login.service";
import { issueWhatsAppProof } from "../services/identity-wa-proof.service";
import { processInboundWhatsApp } from "../services/identity-wa-inbound.service";
import {
  mapKirimdevSender,
  unmapKirimdevSender,
} from "./helpers/kirimdev-sender";
import {
  createIdentityScope,
  createIdentityTenant,
  uniqueDigits,
} from "./helpers/identity-isolation";

const SECRET = "test-live-channel-first-secret";

const TENANT_A: string = randomUUID();
const RECEIVING_A = `62811${uniqueDigits(7)}`;
const MAPPED_M = `livem${uniqueDigits(8)}`;
const MAPPED_N = `liven${uniqueDigits(8)}`;
const SENDER = `62813${uniqueDigits(8)}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const isolation = createIdentityScope(owner);
isolation.scope.tenantIds.push(TENANT_A);
isolation.scope.receivingNumbers.push(RECEIVING_A, MAPPED_M, MAPPED_N);
isolation.scope.senders.push(SENDER);

const tenantContext = (tenantId: string) =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });

function scoped(tenantId: string) {
  return establishScopedTenantContext(tenantContext(tenantId), {
    kind: "tenant",
  });
}

const nonce = () => randomBytes(32).toString("base64url");

async function issueLogin(tenantId: string) {
  return issueWhatsAppChallenge(
    tenantContext(tenantId),
    { bindingNonce: nonce(), link: null, ip: null, userAgent: null },
    {},
  );
}

async function issueProof(tenantId: string) {
  const context = scoped(tenantId);
  const expectedSenderHash = await whatsAppDigest(SENDER);
  return withTenant(db, context, (tx) =>
    issueWhatsAppProof(tx, context, {
      purpose: "payslip_pin_reset",
      userId: randomUUID(),
      sessionId: `sess-${randomUUID()}`,
      bindingHash: browserBindingDigest(nonce()),
      expectedSenderHash,
      ipHash: null,
      userAgent: "uji",
      now: new Date(),
      webhookSecrets: [SECRET],
    }),
  );
}

function inbound(text: string, receivingNumber: string) {
  return {
    eventId: `wamid.${randomUUID()}`,
    receivingNumber,
    sender: SENDER,
    text,
  };
}

async function statusOf(challengeId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM login_challenges WHERE id = $1",
    [challengeId],
  );
  return rows[0]?.status;
}

/** Every audit row of the claiming tenant (owner connection: sees all rows). */
async function auditCount(tenantId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1",
    [tenantId],
  );
  return rows[0]!.n;
}

beforeAll(async () => {
  await createIdentityTenant(owner, "live-a", RECEIVING_A, {
    id: TENANT_A,
    withDomain: false,
  });
});

// createIdentityTenant maps RECEIVING_A: each test states its own mapping.
beforeEach(async () => {
  await isolation.cleanup();
  await unmapKirimdevSender(TENANT_A);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  releaseTrustedProxy();
  await isolation.cleanup();
  await unmapKirimdevSender(TENANT_A);
  await isolation.dropTenants([TENANT_A]);
  await owner.end();
});

describe("legend-3hb1n sign-in without a live channel", () => {
  it("AUTH-02 an old challenge, mapping gone: rejected, no account created, no audit in the claiming tenant", async () => {
    await mapKirimdevSender(TENANT_A, MAPPED_M);
    const issued = await issueLogin(TENANT_A);
    // The channel stops being live while the challenge (TTL 5 min) is pending.
    await unmapKirimdevSender(TENANT_A);

    const identitiesBefore = await isolation.count("user_identities");
    const sessionsBefore = await isolation.count("session");
    const auditBefore = await auditCount(TENANT_A);

    const outcome = await processInboundWhatsApp(
      inbound(`MASUK LEGEND ${issued.codeFormatted}`, MAPPED_M),
    );

    expect(outcome.kind).toBe("rejected");
    expect(await isolation.count("user_identities")).toBe(identitiesBefore);
    expect(await isolation.count("session")).toBe(sessionsBefore);
    expect(await auditCount(TENANT_A)).toBe(auditBefore);
    expect(await statusOf(issued.challenge.id)).toBe("pending");
  });

  it("AUTH-02 an old challenge, mapping re-pointed to another number: rejected, no account (own audit stays, legend-wq3f)", async () => {
    await mapKirimdevSender(TENANT_A, MAPPED_M);
    const issued = await issueLogin(TENANT_A);
    await mapKirimdevSender(TENANT_A, MAPPED_N);

    const identitiesBefore = await isolation.count("user_identities");
    const auditBefore = await auditCount(TENANT_A);

    const outcome = await processInboundWhatsApp(
      inbound(`MASUK LEGEND ${issued.codeFormatted}`, MAPPED_M),
    );

    expect(outcome.kind).toBe("rejected");
    expect(await isolation.count("user_identities")).toBe(identitiesBefore);
    expect(await auditCount(TENANT_A)).toBe(auditBefore + 1);
    expect(await statusOf(issued.challenge.id)).toBe("pending");
  });
});

describe("legend-3hb1n purpose mismatch without a live channel", () => {
  it("AUTH-02 a proof code sent as MASUK, mapping gone: rejected, no account, no audit in the claiming tenant", async () => {
    await mapKirimdevSender(TENANT_A, MAPPED_M);
    const issued = await issueProof(TENANT_A);
    await unmapKirimdevSender(TENANT_A);

    const identitiesBefore = await isolation.count("user_identities");
    const auditBefore = await auditCount(TENANT_A);

    const outcome = await processInboundWhatsApp(
      inbound(`MASUK LEGEND ${issued.code}`, MAPPED_M),
    );

    expect(outcome.kind).toBe("rejected");
    expect(await isolation.count("user_identities")).toBe(identitiesBefore);
    expect(await auditCount(TENANT_A)).toBe(auditBefore);
    expect(await statusOf(issued.challengeId)).toBe("pending");
  });

  it("AUTH-02 a login code sent as RESET PIN, mapping gone: rejected, no audit in the claiming tenant", async () => {
    await mapKirimdevSender(TENANT_A, MAPPED_M);
    const issued = await issueLogin(TENANT_A);
    await unmapKirimdevSender(TENANT_A);

    const identitiesBefore = await isolation.count("user_identities");
    const auditBefore = await auditCount(TENANT_A);

    const outcome = await processInboundWhatsApp(
      inbound(`RESET PIN ${issued.codeFormatted}`, MAPPED_M),
    );

    expect(outcome.kind).toBe("rejected");
    expect(await isolation.count("user_identities")).toBe(identitiesBefore);
    expect(await auditCount(TENANT_A)).toBe(auditBefore);
    expect(await statusOf(issued.challenge.id)).toBe("pending");
  });
});

describe("legend-3hb1n live channel keeps working", () => {
  it("AUTH-02 a live, matching channel: sign-in completes and the account is created", async () => {
    await mapKirimdevSender(TENANT_A, MAPPED_M);
    const issued = await issueLogin(TENANT_A);
    const identitiesBefore = await isolation.count("user_identities");

    const outcome = await processInboundWhatsApp(
      inbound(`MASUK LEGEND ${issued.codeFormatted}`, MAPPED_M),
    );

    expect(outcome.kind).toBe("login");
    expect(await statusOf(issued.challenge.id)).toBe("completed");
    expect(await isolation.count("user_identities")).toBe(identitiesBefore + 1);
  });

  it("AUTH-02 a live, matching channel: a proof code sent as RESET PIN still completes the proof", async () => {
    await mapKirimdevSender(TENANT_A, MAPPED_M);
    const issued = await issueProof(TENANT_A);

    const outcome = await processInboundWhatsApp(
      inbound(`RESET PIN ${issued.code}`, MAPPED_M),
    );

    expect(outcome.kind).toBe("proof");
    expect(await statusOf(issued.challengeId)).toBe("completed");
  });
});
