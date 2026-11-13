// WhatsApp inbound routing only via the platform sender mapping (legend-52tdq,
// AUTH-02). Written from docs/briefs/legend-52tdq.md, before the code.
//
// A tenant admin writes `tenant_integrations.config` and so can type any
// `phoneNumberId`. Only `kirimdev_sender_mappings` (platform written) may decide
// which number a tenant's WhatsApp login / proof challenge is routed by:
//  - no tenant-wide mapping: issuing a challenge fails closed with 503
//    SERVICE_UNAVAILABLE, whatever `config.phoneNumberId` or
//    `config.receivingNumber` say;
//  - mapping M, config says X: an inbound message on X is not routed to the
//    tenant, an inbound message on M is;
//  - each rejected routing logs one warn with the tenant id and a reason, never
//    a number, a sender or the message text.
//
// Assumptions (also reported):
//  - A message on a number other than the challenge's routing number gives the
//    outcome kind "rejected", like a code on another tenant's number does today
//    (wa-proof.test.ts). The challenge stays pending.
//  - The proof flow (issueWhatsAppProof) fails closed the same way as the login
//    flow. PIN reset through the HRIS route uses that same proof service, so it
//    is pinned here at the service and not repeated with HR fixtures
//    (payslip-pin-wa-reset.test.ts holds the route flow).
//  - The reject warn goes through the shared `logger` singleton or the app's
//    injected logger; the test reads both. "one warn" is asserted as at least
//    one warn that names the tenant id; the no-number rule covers all of them.
//  - Outlet-scoped mappings (outlet_id not null) are not tenant-wide and are not
//    covered here: they need outlet fixtures and the brief only names the
//    tenant-wide row.

// Must stay the first import: it sets TRUST_PROXY before ../app reads the env.
import {
  FILE_CLIENT_IP,
  releaseTrustedProxy,
} from "./helpers/identity-client-ip";
import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
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
import { signKirimWebhook } from "@starter/shared/adapters";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { browserBindingDigest, whatsAppDigest } from "../lib/identity-digest";
import { createLogger, logger } from "../lib/logger";
import { issueWhatsAppChallenge } from "../services/identity-login.service";
import { issueWhatsAppProof } from "../services/identity-wa-proof.service";
import { processInboundWhatsApp } from "../services/identity-wa-inbound.service";
import { agent } from "./helpers";
import {
  mapKirimdevSender,
  unmapKirimdevSender,
} from "./helpers/kirimdev-sender";
import {
  createIdentityScope,
  createIdentityTenant,
  uniqueDigits,
} from "./helpers/identity-isolation";

const SECRET = "test-sender-mapping-secret";
const UNAVAILABLE = "Masuk dengan WhatsApp belum tersedia untuk tenant ini.";

const TENANT_A: string = randomUUID();
const TENANT_B: string = randomUUID();
// MSISDN shown to the guest (config.receivingNumber), the number the tenant
// admin typed as config.phoneNumberId (X), and the platform-mapped number (M).
const RECEIVING_A = `62811${uniqueDigits(7)}`;
const RECEIVING_B = `62811${uniqueDigits(7)}`;
const CLAIMED_X = `claimx${uniqueDigits(8)}`;
const MAPPED_M = `mapm${uniqueDigits(8)}`;
const MAPPED_B = `mapb${uniqueDigits(8)}`;
const SENDER = `62813${uniqueDigits(8)}`;
let HOST = "";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const app = createApp({ whatsappWebhookSecrets: [SECRET] });
const fileAgent = (target: Parameters<typeof agent>[0]) =>
  agent(target).set("X-Forwarded-For", FILE_CLIENT_IP);

const isolation = createIdentityScope(owner);
isolation.scope.tenantIds.push(TENANT_A, TENANT_B);
isolation.scope.receivingNumbers.push(
  RECEIVING_A,
  RECEIVING_B,
  CLAIMED_X,
  MAPPED_M,
  MAPPED_B,
);
isolation.scope.senders.push(SENDER);

const tenantContext = (tenantId: string) =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });

function scoped(tenantId: string) {
  return establishScopedTenantContext(tenantContext(tenantId), {
    kind: "tenant",
  });
}

const nonce = () => randomBytes(32).toString("base64url");

/** The tenant admin's own write: any phoneNumberId, no platform check. */
async function setConfigPhoneNumberId(
  tenantId: string,
  phoneNumberId: string | null,
) {
  await owner.query(
    `UPDATE tenant_integrations
        SET config = CASE WHEN $2::text IS NULL
                          THEN config - 'phoneNumberId'
                          ELSE config || jsonb_build_object('phoneNumberId', $2::text) END
      WHERE tenant_id = $1 AND provider = 'whatsapp' AND outlet_id IS NULL`,
    [tenantId, phoneNumberId],
  );
}

async function issueLogin(tenantId: string) {
  return issueWhatsAppChallenge(
    tenantContext(tenantId),
    { bindingNonce: nonce(), link: null, ip: null, userAgent: null },
    {},
  );
}

async function issueProof(tenantId: string, sender = SENDER) {
  const context = scoped(tenantId);
  const expectedSenderHash = await whatsAppDigest(sender);
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

function inbound(input: {
  text: string;
  receivingNumber: string;
  sender?: string;
}) {
  return {
    eventId: `wamid.${randomUUID()}`,
    receivingNumber: input.receivingNumber,
    sender: input.sender ?? SENDER,
    text: input.text,
  };
}

async function statusOf(challengeId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM login_challenges WHERE id = $1",
    [challengeId],
  );
  return rows[0]?.status;
}

function webhookBody(input: {
  wamid: string;
  phoneNumberId: string;
  text: string;
}) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-test",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: input.phoneNumberId },
              messages: [
                {
                  id: input.wamid,
                  from: SENDER,
                  type: "text",
                  text: { body: input.text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

type Target = Parameters<typeof agent>[0];
async function signedPost(body: string, target: Target = app) {
  const signature = await signKirimWebhook({
    rawBody: body,
    secret: SECRET,
    timestamp: Math.floor(Date.now() / 1000),
  });
  return fileAgent(target)
    .host(HOST)
    .post("/api/webhooks/whatsapp")
    .set("Content-Type", "application/json")
    .set("X-Kirim-Signature", signature)
    .set("X-Kirim-Event-Id", `evt-${randomUUID()}`)
    .send(body);
}

beforeAll(async () => {
  HOST = (
    await createIdentityTenant(owner, "map-a", RECEIVING_A, { id: TENANT_A })
  ).hostname;
  await createIdentityTenant(owner, "map-b", RECEIVING_B, {
    id: TENANT_B,
    withDomain: false,
  });
});

// Other helpers may map a tenant on creation: start from "no mapping" so each
// test states its own mapping.
beforeEach(async () => {
  await isolation.cleanup();
  await unmapKirimdevSender(TENANT_A);
  await unmapKirimdevSender(TENANT_B);
  await setConfigPhoneNumberId(TENANT_A, CLAIMED_X);
  await setConfigPhoneNumberId(TENANT_B, null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  releaseTrustedProxy();
  await isolation.cleanup();
  await unmapKirimdevSender(TENANT_A);
  await unmapKirimdevSender(TENANT_B);
  await isolation.dropTenants([TENANT_A, TENANT_B]);
  await owner.end();
});

describe("legend-52tdq login channel without a platform mapping", () => {
  it("AUTH-02 config.phoneNumberId alone does not open a login challenge: 503, no row", async () => {
    await expect(issueLogin(TENANT_A)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: UNAVAILABLE,
    });
    expect(await isolation.count("login_challenges")).toBe(0);
  });

  it("AUTH-02 config.receivingNumber is no fallback either: no mapping, still 503", async () => {
    await setConfigPhoneNumberId(TENANT_A, null);
    await expect(issueLogin(TENANT_A)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: UNAVAILABLE,
    });
    expect(await isolation.count("login_challenges")).toBe(0);
  });

  it("AUTH-02 an inbound message on the claimed number is routed to nobody", async () => {
    await expect(issueLogin(TENANT_A)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    const outcome = await processInboundWhatsApp(
      inbound({
        text: "MASUK LEGEND AAAAAA00",
        receivingNumber: CLAIMED_X,
      }),
    );
    expect(outcome.kind).toBe("rejected");
    expect(await isolation.count("login_challenges")).toBe(0);
    expect(await isolation.count("user_identities")).toBe(0);
    expect(await isolation.count("session")).toBe(0);
  });

  it("AUTH-02 a tenant cannot claim another tenant's mapped number through its config", async () => {
    await mapKirimdevSender(TENANT_B, MAPPED_B);
    await setConfigPhoneNumberId(TENANT_A, MAPPED_B);
    const issuedB = await issueLogin(TENANT_B);
    await expect(issueLogin(TENANT_A)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: UNAVAILABLE,
    });
    // B's login still works on B's mapped number and completes B's challenge.
    const outcome = await processInboundWhatsApp(
      inbound({
        text: `MASUK LEGEND ${issuedB.codeFormatted}`,
        receivingNumber: MAPPED_B,
      }),
    );
    expect(outcome.kind).toBe("login");
    expect(await statusOf(issuedB.challenge.id)).toBe("completed");
  });
});

describe("legend-52tdq login channel with a platform mapping", () => {
  it("AUTH-02 mapped to M, config says X: a code on X is not routed, the same code on M logs in", async () => {
    await mapKirimdevSender(TENANT_A, MAPPED_M);
    const issued = await issueLogin(TENANT_A);

    const onClaimed = await processInboundWhatsApp(
      inbound({
        text: `MASUK LEGEND ${issued.codeFormatted}`,
        receivingNumber: CLAIMED_X,
      }),
    );
    expect(onClaimed.kind).toBe("rejected");
    expect(await statusOf(issued.challenge.id)).toBe("pending");
    expect(await isolation.count("user_identities")).toBe(0);
    expect(await isolation.count("session")).toBe(0);

    const onMapped = await processInboundWhatsApp(
      inbound({
        text: `MASUK LEGEND ${issued.codeFormatted}`,
        receivingNumber: MAPPED_M,
      }),
    );
    expect(onMapped.kind).toBe("login");
    expect(await statusOf(issued.challenge.id)).toBe("completed");
  });

  it("AUTH-02 through the signed webhook: phone_number_id X completes nothing, M completes the challenge", async () => {
    await mapKirimdevSender(TENANT_A, MAPPED_M);
    const issued = await issueLogin(TENANT_A);
    const text = `MASUK LEGEND ${issued.codeFormatted}`;

    const onClaimed = await signedPost(
      webhookBody({
        wamid: `wamid.${randomUUID()}`,
        phoneNumberId: CLAIMED_X,
        text,
      }),
    );
    // 200, not 4xx: Kirimdev disables a subscription after repeated failures.
    expect(onClaimed.status).toBe(200);
    expect(onClaimed.body.data.completed).toBe(0);
    expect(await statusOf(issued.challenge.id)).toBe("pending");

    const onMapped = await signedPost(
      webhookBody({
        wamid: `wamid.${randomUUID()}`,
        phoneNumberId: MAPPED_M,
        text,
      }),
    );
    expect(onMapped.status).toBe(200);
    expect(onMapped.body.data.completed).toBe(1);
    expect(await statusOf(issued.challenge.id)).toBe("completed");
  });
});

describe("legend-52tdq WhatsApp proof channel", () => {
  it("AUTH-02 no mapping: a proof is not issued, config.phoneNumberId notwithstanding", async () => {
    await expect(issueProof(TENANT_A)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(await isolation.count("login_challenges")).toBe(0);
  });

  it("AUTH-02 mapped to M, config says X: RESET PIN on X is rejected, on M completes the proof", async () => {
    await mapKirimdevSender(TENANT_A, MAPPED_M);
    const issued = await issueProof(TENANT_A);

    const onClaimed = await processInboundWhatsApp(
      inbound({
        text: `RESET PIN ${issued.code}`,
        receivingNumber: CLAIMED_X,
      }),
    );
    expect(onClaimed.kind).toBe("rejected");
    expect(await statusOf(issued.challengeId)).toBe("pending");

    const onMapped = await processInboundWhatsApp(
      inbound({
        text: `RESET PIN ${issued.code}`,
        receivingNumber: MAPPED_M,
      }),
    );
    expect(onMapped.kind).toBe("proof");
    expect(await statusOf(issued.challengeId)).toBe("completed");
  });
});

describe("legend-52tdq reject log hygiene", () => {
  it("AUTH-02 a routing reject logs a warn with the tenant id and never a number, sender or code", async () => {
    await mapKirimdevSender(TENANT_A, MAPPED_M);
    const issued = await issueLogin(TENANT_A);
    const code = issued.codeFormatted;

    // Two sinks: calls on the shared singleton logger (spied, still logged) and
    // the app's own logger writing to a stream.
    const spied: unknown[] = [];
    const warn = logger.warn.bind(logger);
    vi.spyOn(logger, "warn").mockImplementation(((...args: unknown[]) => {
      spied.push(args);
      return (warn as (...a: unknown[]) => void)(...args);
    }) as typeof logger.warn);
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const loggedApp = createApp({
      whatsappWebhookSecrets: [SECRET],
      logger: createLogger({ level: "debug", destination: stream }),
    });

    const response = await signedPost(
      webhookBody({
        wamid: `wamid.${randomUUID()}`,
        phoneNumberId: CLAIMED_X,
        text: `MASUK LEGEND ${code}`,
      }),
      loggedApp,
    );
    expect(response.status).toBe(200);
    expect(await statusOf(issued.challenge.id)).toBe("pending");

    // pino-http writes when the response finishes: let the access line land.
    await vi.waitFor(() => {
      expect(lines.join("").length).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const streamWarns = lines
      .flatMap((chunk) => chunk.split("\n"))
      .filter((line) => /"level":40\b/.test(line));
    const warns = [
      ...spied.map((entry) => JSON.stringify(entry)),
      ...streamWarns,
    ];
    // Missing today: the reject is silent.
    expect(warns.some((entry) => entry.includes(TENANT_A))).toBe(true);

    const everything = [...warns, lines.join("")].join("\n");
    for (const secret of [
      CLAIMED_X,
      MAPPED_M,
      RECEIVING_A,
      SENDER,
      SENDER.slice(2),
      code,
      code.replace(/\W/g, ""),
      "MASUK LEGEND",
      SECRET,
    ]) {
      expect(everything).not.toContain(secret);
    }
  });
});
