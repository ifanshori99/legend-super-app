// B5a (legend-wasr7.23): the `bca_cloud` EDC provider (BCA ECR cloud API over
// SNAP) inside the cloud EDC agent. Cashier HTTP -> POS route -> resolver ->
// cloud agent -> BcaCloudProvider -> stub BCA gateway
// (src/test/helpers/bca-ecr-stub.ts).
//
// Mandatory checks of the brief (docs/briefs/1272-b5a-brief.md):
// - partnerReferenceNo = the agent's trace (same for the inquiry), a new
//   X-EXTERNAL-ID per request, the amount only from the server's bill;
// - 202IS00, 504IS00, a dropped connection, 409IS00 = `unknown` then
//   inquiry, never `failed`; 409 raises an alert; only a 4xx answered
//   before processing ends the sale `declined`;
// - the access token is cached until expiry - 60 s; a token BCA forgot is
//   dropped and fetched again;
// - no credentials = no provider; the outlet's bca_cloud terminal is not
//   ready (EDC_AGENT_NOT_READY);
// - bead notes: bridge `evidence()` re-parses with the shared schemas;
//   `prepareSale` takes only outlets with an active bca_cloud terminal;
// - logs: no token, secret, signature or PAN.
//
// Signature vectors are pinned to the SNAP standard: belum diverifikasi bank
// (BCA-DOC in bca-snap-client.ts).
import { generateKeyPairSync, createVerify, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  EcrTransportError,
  EdcError,
  type EcrTerminal,
} from "@starter/shared/edc";
import {
  BcaCloudProvider,
  bcaVoidReference,
  createBcaCloudProviderFromEnv,
} from "../edge/edc/bca-cloud-provider.ts";
import {
  minifyJson,
  newExternalId,
  snapTimestamp,
  tokenSignature,
  tokenStringToSign,
  transactionSignature,
  transactionStringToSign,
} from "../edge/edc/bca-snap-client.ts";
import { createSimulatorBridgeCodec } from "../edge/edc/bridge-codec.ts";
import { EdcBridgeProvider } from "../edge/edc/bridge-provider.ts";
import {
  CloudEdcRuntime,
  startCloudEdcRuntime,
  stopCloudEdcRuntime,
} from "../edge/edc/cloud-runtime.ts";
import { bcaCloudConfigProblems } from "../config/env.ts";
import { logger } from "../lib/logger.ts";
import { owner } from "./floor-test-helpers.ts";
import { startBcaEcrStub, type BcaEcrStub } from "./helpers/bca-ecr-stub.ts";
import {
  holdFixture,
  newSubmittedOrder,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 60_000 });

const CLIENT_ID = "b5a-client";
const CLIENT_SECRET = `b5a-secret-${randomUUID()}`;
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const PAN = "4111111111111111";

// ------------------------------------------------------------- no database

describe("B5a SNAP signatures (belum diverifikasi bank)", () => {
  it("b5a-1 timestamp, string-to-sign and HMAC-SHA512 pinned to the SNAP standard", () => {
    const timestamp = snapTimestamp(new Date("2026-11-27T03:04:05.000Z"));
    expect(timestamp).toBe("2026-11-27T10:04:05+07:00");
    const body = minifyJson({
      partnerReferenceNo: "TRACE0001",
      amount: { value: "33000.00", currency: "IDR" },
    });
    const input = {
      method: "POST",
      path: "/openapi/v1.0/ecr/payment",
      accessToken: "TOKEN123",
      body,
      timestamp,
    };
    expect(transactionStringToSign(input)).toBe(
      "POST:/openapi/v1.0/ecr/payment:TOKEN123:4d2e17208470b2c884867bc7fe15bddd507f5f2d36753bdcd67e54b12d1b3955:2026-11-27T10:04:05+07:00",
    );
    expect(transactionSignature("SECRET-B5A", input)).toBe(
      "05gbIiEVzi9H0rn+JNHg9GZa8ELJauBanfO8TY+urkynbVMZoQOgxOKhZmR0nojINpgEPu4+Pw+68Sdme4zmvg==",
    );
    expect(tokenStringToSign("CID", timestamp)).toBe(
      "CID|2026-11-27T10:04:05+07:00",
    );
    const signature = tokenSignature(privateKey, "CID", timestamp);
    expect(
      createVerify("RSA-SHA256")
        .update("CID|2026-11-27T10:04:05+07:00")
        .verify(publicKey, signature, "base64"),
    ).toBe(true);
    const ids = new Set(Array.from({ length: 200 }, () => newExternalId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^\d{32}$/);
  });
});

describe("B5a configuration", () => {
  it("b5a-2 no credentials = no provider; a partial set, http in production or a bad key file is refused by name only", () => {
    expect(
      createBcaCloudProviderFromEnv({
        BETTER_AUTH_URL: "http://localhost:4000",
      }),
    ).toBeNull();
    expect(bcaCloudConfigProblems({})).toEqual([]);
    const partial = bcaCloudConfigProblems({
      EDC_BCA_CLOUD_CLIENT_SECRET: CLIENT_SECRET,
    });
    expect(partial.map((p) => p.path[0])).toEqual([
      "EDC_BCA_CLOUD_BASE_URL",
      "EDC_BCA_CLOUD_CLIENT_ID",
      "EDC_BCA_CLOUD_PRIVATE_KEY_PATH",
      "EDC_BCA_CLOUD_PARTNER_ID",
      "EDC_BCA_CLOUD_CHANNEL_ID",
    ]);
    const dir = mkdtempSync(join(tmpdir(), "b5a-"));
    const keyPath = join(dir, "key.pem");
    writeFileSync(
      keyPath,
      privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      { mode: 0o600 },
    );
    const full = {
      EDC_BCA_CLOUD_BASE_URL: "http://bca.example",
      EDC_BCA_CLOUD_CLIENT_ID: CLIENT_ID,
      EDC_BCA_CLOUD_CLIENT_SECRET: CLIENT_SECRET,
      EDC_BCA_CLOUD_PRIVATE_KEY_PATH: keyPath,
      EDC_BCA_CLOUD_PARTNER_ID: "PARTNER",
      EDC_BCA_CLOUD_CHANNEL_ID: "95221",
    };
    expect(bcaCloudConfigProblems({ ...full, NODE_ENV: "test" })).toEqual([]);
    const production = bcaCloudConfigProblems({
      ...full,
      NODE_ENV: "production",
      EDC_BCA_CLOUD_PRIVATE_KEY_PATH: join(dir, "missing.pem"),
    });
    expect(production.map((p) => p.path[0])).toEqual([
      "EDC_BCA_CLOUD_BASE_URL",
      "EDC_BCA_CLOUD_PRIVATE_KEY_PATH",
    ]);
    expect(JSON.stringify([partial, production])).not.toContain(CLIENT_SECRET);
    expect(
      createBcaCloudProviderFromEnv({
        ...full,
        BETTER_AUTH_URL: "http://localhost:4000",
      }),
    ).toBeInstanceOf(BcaCloudProvider);
  });

  it("b5a-3 a bca_cloud terminal without the provider is not ready (EDC manual), not an unknown bank", async () => {
    const cloud = new CloudEdcRuntime({ codecs: [], renewMs: 3_600_000 });
    try {
      expect(() =>
        cloud.registry.get("bca", {
          id: randomUUID(),
          tenantId: randomUUID(),
          outletId: randomUUID(),
          connectionKind: "bca_cloud",
        }),
      ).toThrow(new EdcError("EDC_AGENT_NOT_READY"));
    } finally {
      await cloud.stop();
    }
  });
});

describe("B5a bridge evidence (bead note 1)", () => {
  it("b5a-4 evidence() re-parses the codec output: a card number in a reference field is never stored", () => {
    const base = createSimulatorBridgeCodec("bca");
    const loose = {
      ...base,
      decodeResult: () =>
        ({
          outcome: "approved",
          amountIdr: 33_000,
          approvalCode: "A1B2C3",
          rrn: PAN,
          responseCode: "00",
          cardType: "VISA",
          maskedPan: null,
          message: null,
          invoiceNo: PAN,
          batchNo: "000001",
          trace: "TRACE01",
        }) as never,
      decodeInquiry: () =>
        ({
          outcome: "approved",
          amountIdr: 33_000,
          approvalCode: "A1B2C3",
          rrn: "RRN1",
          pan: PAN,
        }) as never,
    };
    const provider = new EdcBridgeProvider(
      loose,
      { ready: () => true, send: () => null },
      { saleTimeoutMs: 1_000, traceTimeoutMs: 1_000 },
    );
    const answer = { outcome: "response" as const, frame: "e30=" };
    const sale = provider.evidence("sale", answer);
    expect(sale).toMatchObject({ outcome: "approved", rrn: null });
    expect(sale?.invoiceNo).toBeNull();
    expect(JSON.stringify(sale)).not.toContain(PAN);
    // An extra field (here a PAN) makes the answer unreadable: nothing kept.
    expect(provider.evidence("inquiry", answer)).toBeNull();
  });
});

// ---------------------------------------------------------------- database

let fx: HoldFixture;
let stub: BcaEcrStub;
let provider: BcaCloudProvider;
let runtime: CloudEdcRuntime;
let offsetMs = 0;
let outletX: string;
let spies: Array<MockInstance<(...args: never[]) => unknown>> = [];
const terminal = randomUUID();
const TID = "TID-B5A-1";
const MID = "MID-B5A";

/** Backends holding the agent's advisory lock of one outlet. */
async function outletLocks(outletId: string) {
  const name = `edc-agent:${fx.tenant.tenantId.toLowerCase()}:${outletId.toLowerCase()}`;
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM pg_locks l, LATERAL (SELECT hashtextextended($1, 0) AS h) k
      WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
        AND l.classid::bigint = ((k.h >> 32) & 4294967295)
        AND l.objid::bigint = (k.h & 4294967295)`,
    [name],
  );
  return rows[0]!.n;
}

async function asTenant(text: string, params: unknown[]) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [fx.tenant.tenantId],
    );
    await client.query(text, params);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

const ecrTerminal = (): EcrTerminal => ({
  tenantId: fx.tenant.tenantId,
  outletId: fx.tenant.outletId,
  id: terminal,
  bank: "bca",
  terminalId: TID,
  merchantId: MID,
  connection: "lan",
  ipAddress: null,
});

async function paymentOptions() {
  const res = await fx.get(
    `/api/outlets/${fx.tenant.outletId}/pos/payment-options`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.edc.ecrEnabled as boolean;
}

/** A sale on the bca_cloud terminal for a new bill. */
async function sale() {
  const order = await newSubmittedOrder(fx, 0);
  const owed = order.totalIdr - order.depositAppliedIdr;
  const res = await fx.post(`${fx.base}/${order.id}/edc`, {
    terminalId: terminal,
    method: "card",
    idempotencyKey: randomUUID(),
  });
  return { res, owed };
}

async function inquire(transactionId: string) {
  const res = await fx.post(
    `/api/outlets/${fx.tenant.outletId}/pos/edc/${transactionId}/inquire`,
    {},
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { status: string; needsReconciliation: boolean };
}

const payments = () =>
  stub.requests.filter(
    (r) => r.path === "/openapi/v1.0/ecr/payment" && r.body.transType !== "08",
  );

beforeAll(async () => {
  spies = (["trace", "debug", "info", "warn", "error", "fatal"] as const).map(
    (level) =>
      vi.spyOn(logger, level) as unknown as MockInstance<
        (...args: never[]) => unknown
      >,
  );
  fx = await holdFixture("edc-bca-b5a");
  outletX = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet B5a tanpa BCA', 'Jl. Uji 5', timezone, opening_hours, 'active'
       FROM outlets WHERE id = $3`,
    [outletX, `X${outletX.slice(0, 6)}`.toUpperCase(), fx.tenant.outletId],
  );
  await asTenant(
    `INSERT INTO payment_edc_terminals
       (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
        connection, ip_address, supported_methods, status, connection_kind)
     VALUES ($1, $2, $3, 'bca', $4, $5, 'BCA cloud', 'lan', NULL,
             ARRAY['card','qris'], 'active', 'bca_cloud')`,
    [terminal, fx.tenant.tenantId, fx.tenant.outletId, TID, MID],
  );
  stub = await startBcaEcrStub({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    publicKey,
  });
  provider = new BcaCloudProvider(
    {
      baseUrl: stub.baseUrl,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      privateKey,
      partnerId: "PARTNER-B5A",
      channelId: "95221",
      origin: "https://legend.example",
    },
    {
      now: () => new Date(Date.now() + offsetMs),
      saleTimeoutMs: 3_000,
      traceTimeoutMs: 3_000,
    },
  );
  runtime = startCloudEdcRuntime({
    codecs: [],
    bcaCloud: provider,
    saleTimeoutMs: 5_000,
    traceTimeoutMs: 5_000,
    renewMs: 3_600_000,
    retryDelayMs: () => 200,
  });
});

afterAll(async () => {
  await stopCloudEdcRuntime();
  await stub?.close();
  resetHoldPorts();
  for (const spy of spies) spy.mockRestore();
  await owner.end();
});

describe("B5a outlet lock (bead note 2)", () => {
  it("b5a-5 only an outlet with an active bca_cloud terminal is taken: payment options take it lazily, others never", async () => {
    expect(await outletLocks(fx.tenant.outletId)).toBe(0);
    // No bca_cloud terminal: no lock, whether rows are given or read.
    await runtime.prepareSale(fx.tenant.tenantId, outletX);
    await runtime.prepareSale(fx.tenant.tenantId, outletX, [
      { bankCode: "bca", connectionKind: "bridge", status: "active" },
      { bankCode: "bca", connectionKind: "bca_cloud", status: "inactive" },
    ]);
    expect(runtime.agentFor(fx.tenant.tenantId, outletX)).toBeNull();
    expect(await outletLocks(outletX)).toBe(0);
    expect(stub.tokenRequests()).toBe(0);
    // The outlet with one: token fetched, outlet taken, ECR on.
    expect(await paymentOptions()).toBe(true);
    expect(await outletLocks(fx.tenant.outletId)).toBe(1);
    expect(stub.tokenRequests()).toBe(1);
    // Idempotent, and the token stays cached.
    expect(await paymentOptions()).toBe(true);
    expect(await outletLocks(fx.tenant.outletId)).toBe(1);
    expect(stub.tokenRequests()).toBe(1);
    // Boot lists the same outlet (no hello for bca_cloud).
    expect(await provider.outlets()).toContainEqual({
      tenantId: fx.tenant.tenantId,
      outletId: fx.tenant.outletId,
    });
  });
});

describe("B5a sale on the BCA ECR cloud API", () => {
  it("b5a-6 approved: partnerReferenceNo = trace, amount from the bill, signed SNAP headers", async () => {
    stub.script(TID, "approved");
    const { res, owed } = await sale();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      status: "approved",
      amountIdr: owed,
      approvalCode: "A1B2C3",
      maskedPan: "411111******1111",
    });
    const sent = payments().at(-1)!;
    expect(sent.signatureOk).toBe(true);
    expect(sent.body).toMatchObject({
      partnerReferenceNo: res.body.data.trace,
      merchantId: MID,
      terminalId: TID,
      amount: { value: `${owed}.00`, currency: "IDR" },
    });
    expect(sent.headers).toMatchObject({
      "x-partner-id": "PARTNER-B5A",
      "channel-id": "95221",
      origin: "https://legend.example",
    });
    expect(sent.headers["x-external-id"]).toMatch(/^\d{32}$/);
  });

  it("b5a-7 declined by the bank, and a 4xx before processing, end declined with the code", async () => {
    stub.script(TID, "declined");
    const declined = await sale();
    expect(declined.res.body.data.status).toBe("declined");
    stub.script(TID, "rejected");
    const rejected = await sale();
    expect(rejected.res.body.data).toMatchObject({
      status: "declined",
      responseCode: "400IS02",
    });
  });

  it("b5a-8 202IS00 = unknown, then the inquiry (same partnerReferenceNo, new external id) settles approved", async () => {
    stub.script(TID, "pending_then_approved");
    const { res, owed } = await sale();
    expect(res.body.data.status).toBe("unknown");
    const settled = await inquire(res.body.data.id);
    expect(settled.status).toBe("approved");
    const asked = stub.requests.at(-1)!;
    expect(asked.path).toBe("/openapi/v1.0/ecr/inquiry-status");
    expect(asked.body.originalPartnerReferenceNo).toBe(res.body.data.trace);
    expect(asked.headers["x-external-id"]).not.toBe(
      payments().at(-1)!.headers["x-external-id"],
    );
    expect(res.body.data.amountIdr).toBe(owed);
  });

  it("b5a-9 504IS00 then not found: stays unknown (never failed)", async () => {
    stub.script(TID, "timeout_then_not_found");
    const { res } = await sale();
    expect(res.body.data.status).toBe("unknown");
    const after = await inquire(res.body.data.id);
    expect(after.status).toBe("unknown");
  });

  it("b5a-10 connection dropped after the request was sent: unknown, then inquiry approved", async () => {
    stub.script(TID, "drop_after_send");
    const { res } = await sale();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe("unknown");
    expect((await inquire(res.body.data.id)).status).toBe("approved");
  });

  it("b5a-11 409IS00 (external id reused) = unknown plus an ops alert", async () => {
    stub.script(TID, "conflict");
    const errors = spies[4]!;
    const before = errors.mock.calls.length;
    const { res } = await sale();
    expect(res.body.data.status).toBe("unknown");
    expect(
      errors.mock.calls
        .slice(before)
        .some(
          ([fields]) =>
            (fields as { alert?: string }).alert ===
            "edc_bca_cloud_external_id_reused",
        ),
    ).toBe(true);
    expect((await inquire(res.body.data.id)).status).toBe("unknown");
  });

  it("b5a-12 every request carries its own X-EXTERNAL-ID", () => {
    const ids = stub.requests.map((r) => r.headers["x-external-id"]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("B5a access token", () => {
  it("b5a-13 a token BCA forgot ends the sale declined (not processed), is dropped and fetched again", async () => {
    stub.script(TID, "approved");
    stub.expireTokens();
    const before = stub.tokenRequests();
    const refused = await sale();
    expect(refused.res.body.data).toMatchObject({
      status: "declined",
      responseCode: "401IS01",
    });
    // Next sale: prepare fetches a new token first.
    const again = await sale();
    expect(again.res.body.data.status).toBe("approved");
    expect(stub.tokenRequests()).toBe(before + 1);
  });

  it("b5a-14 cached until expiry - 60 s, then fetched again before the sale", async () => {
    const before = stub.tokenRequests();
    offsetMs += 900_000 - 65_000;
    expect((await sale()).res.body.data.status).toBe("approved");
    expect(stub.tokenRequests()).toBe(before);
    offsetMs += 6_000;
    expect((await sale()).res.body.data.status).toBe("approved");
    expect(stub.tokenRequests()).toBe(before + 1);
  });
});

describe("B5a void and cancel", () => {
  it("b5a-15 void (transType 08) cancels an approved sale only; cancel is never claimed", async () => {
    stub.script(TID, "approved");
    const { res } = await sale();
    const trace = res.body.data.trace as string;
    const signal = new AbortController().signal;
    const voided = await provider.void({
      terminal: ecrTerminal(),
      trace,
      signal,
    });
    expect(voided).toMatchObject({ outcome: "cancelled", trace });
    const sent = stub.requests.at(-1)!;
    expect(sent.body).toMatchObject({
      transType: "08",
      partnerReferenceNo: bcaVoidReference(trace),
      originalPartnerReferenceNo: trace,
    });
    // Already voided / never approved: no claim.
    await expect(
      provider.void({ terminal: ecrTerminal(), trace, signal }),
    ).rejects.toBeInstanceOf(EcrTransportError);
    await expect(provider.cancel()).rejects.toBeInstanceOf(EcrTransportError);
  });

  it("b5a-16 no token cached: the sale is never sent (failed 'never sent', not unknown)", async () => {
    // BCA unreachable for a token: nothing usable, nothing sent.
    const offline = new BcaCloudProvider({
      baseUrl: "http://127.0.0.1:9",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      privateKey,
      partnerId: "P",
      channelId: "C",
      origin: "https://legend.example",
    });
    expect(offline.ready()).toBe(false);
    await offline.prepare();
    expect(offline.ready()).toBe(false);
    await expect(
      offline.sale({
        terminal: ecrTerminal(),
        trace: "TRACENOSEND1",
        amountIdr: 1_000 as never,
        method: "card",
        reference: "R1",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(new EdcError("EDC_AGENT_NOT_READY"));
  });
});

describe("B5a logs", () => {
  it("b5a-17 no token, client secret, signature or PAN in any log call", () => {
    const logged = inspect(
      spies.map((spy) => spy.mock.calls),
      { depth: 10 },
    );
    expect(stub.issued.length).toBeGreaterThan(0);
    for (const token of stub.issued) expect(logged).not.toContain(token);
    expect(logged).not.toContain(CLIENT_SECRET);
    for (const request of stub.requests)
      expect(logged).not.toContain(request.headers["x-signature"]);
    expect(logged).not.toContain(PAN);
  });
});
