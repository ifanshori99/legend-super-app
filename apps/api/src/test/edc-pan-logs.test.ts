// EDC agent log + ledger PAN hygiene (bead legend-5gub, part B).
// A terminal can put a full card number (PAN) into any field it returns, or
// into the text of a transport error. Neither the agent's logger output nor
// the stored ledger rows may ever hold one. Real disposable PostgreSQL, the
// in-memory ECR simulator wrapped so it can return RAW (unparsed) answers.
//
// Assumptions (spec silent):
// - "Looks like a PAN" = /\d(?:[ \t-]*\d){11,}/ (12+ digits, any number of
//   spaces/dashes, repeated or mixed, between digits), and the literal PAN
//   strings used below. 12+ is the free-text threshold of the stored-data
//   scrub (message, card_type, masked_pan); the 13+ reference-column
//   threshold is looser, so this oracle is the stricter of the two.
// - Every level of the agent's module-level `logger` is spied; `child` is
//   spied too and must stay unused (a child logger would escape the spies).
// - A ledger row's free-text/card columns are checked (not ids/timestamps,
//   whose digits can coincidentally form long runs).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
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
  idr,
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  EcrTransportError,
  type EcrInquiryResult,
  type EcrResult,
  type EcrSaleRequest,
  type EcrTraceRequest,
  type EdcPaymentRequest,
  type EdcProvider,
  type EdcTransaction,
} from "@starter/shared/edc";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { createEdcAgent } from "../edge/edc/agent.ts";
import { logger } from "../lib/logger.ts";
import { EdcProviderRegistry } from "../edge/edc/registry.ts";
import { EcrSimulator } from "../edge/edc/simulator.ts";
import { ensureBill } from "./edc-agent-bill-helper.ts";
import { agent as httpAgent, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PAN_PLAIN = "4111111111111111";
const PAN_SPACED = "4111 1111 1111 1111";
const PAN_DASHED = "4111-1111-1111-1111";
const PAN_OTHER = "5500005555555559";
// Repeated and mixed separators (legend-tjwb), and a 12-digit run.
const PAN_MULTI = "4111  1111  1111  1111";
const PAN_MIXED = "4111 - 1111-1111 1111";
const PAN_12 = "411111111111";
const PAN_LITERALS = [
  PAN_PLAIN,
  PAN_SPACED,
  PAN_DASHED,
  PAN_OTHER,
  PAN_MULTI,
  PAN_MIXED,
  PAN_12,
];
const PAN_LIKE = /\d(?:[ \t-]*\d){11,}/;
const AMOUNT = 55_000;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const app = createApp();
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let cashierA: string;
let cashierB: string;

const ctxFor = (tenant: IsolatedTenant): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
  );

async function asOwner<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function staffUser(
  tenant: IsolatedTenant,
  label: string,
): Promise<string> {
  const client = httpAgent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
    [roleId, tenant.tenantId, label, JSON.stringify(["pos.payment.accept"])],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return userId;
}

async function seedTerminal(tenant: IsolatedTenant): Promise<string> {
  const id = randomUUID();
  await asOwner(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', $4, 'MID-TEST', 'Test EDC', 'lan', '10.0.0.5', $5, 'active')`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        `TID-${id.slice(0, 8)}`,
        ["card", "qris"],
      ],
    ),
  );
  return id;
}

type LedgerRow = Record<string, unknown>;

/** The columns a terminal can influence, plus the ones that must not move. */
async function ledger(tenant: IsolatedTenant): Promise<LedgerRow[]> {
  return asOwner(tenant.tenantId, async (client) => {
    const result = await client.query(
      `SELECT * FROM edc_transactions WHERE tenant_id = $1 ORDER BY created_at, id`,
      [tenant.tenantId],
    );
    return result.rows;
  });
}

const CARD_TEXT_COLUMNS = [
  "card_type",
  "masked_pan",
  "rrn",
  "invoice_no",
  "batch_no",
  "dispatch_batch_no",
  "message",
  "approval_code",
  "response_code",
  "trace",
  "reference",
] as const;

// Random UUIDs and ISO timestamps can hold 13+ digits split by dashes by
// chance ("…58-3702-4046-987c…"): blank them before the pattern check so it
// only fires on real card-number-like text. The literal PAN check still runs on
// the full text.
const UUID_OR_TIMESTAMP =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gi;

function expectNoPan(label: string, text: string): void {
  expect(
    text.replace(UUID_OR_TIMESTAMP, "<id>"),
    `${label} matches a card-number pattern`,
  ).not.toMatch(PAN_LIKE);
  for (const pan of PAN_LITERALS)
    expect(text, `${label} contains ${pan}`).not.toContain(pan);
}

function expectLedgerClean(rows: LedgerRow[]): void {
  for (const row of rows)
    for (const column of CARD_TEXT_COLUMNS)
      expectNoPan(`edc_transactions.${column}`, String(row[column] ?? ""));
}

// --- log capture ----------------------------------------------------------

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
type Captured = { level: string; args: unknown[] };
let captured: Captured[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

function serialise(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v instanceof Error
      ? { name: v.name, message: v.message, stack: v.stack, cause: v.cause }
      : typeof v === "bigint"
        ? v.toString()
        : v,
  );
}

const loggedText = () => captured.map((c) => serialise(c)).join("\n");
const loggedMessages = () =>
  captured.map((c) => c.args.find((a) => typeof a === "string") as string);

beforeEach(() => {
  captured = [];
  const target = logger as unknown as Record<
    string,
    (...a: unknown[]) => unknown
  >;
  for (const level of LEVELS) {
    spies.push(
      vi.spyOn(target, level).mockImplementation((...args: unknown[]) => {
        captured.push({ level, args });
      }),
    );
  }
  spies.push(
    vi.spyOn(target, "child").mockImplementation((...args: unknown[]) => {
      captured.push({ level: "child", args });
      return logger;
    }),
  );
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  const all = startedAgents.splice(0);
  for (const { agent, ctx } of all)
    await agent.stop(ctx).catch(() => undefined);
});

// --- fixture --------------------------------------------------------------

const startedAgents: Array<{
  agent: ReturnType<typeof createEdcAgent>;
  ctx: ScopedTenantContext;
}> = [];

type Over = Partial<{
  sale: (r: EcrSaleRequest, sim: EcrSimulator) => Promise<unknown>;
  cancel: (r: EcrTraceRequest, sim: EcrSimulator) => Promise<unknown>;
  inquiry: (r: EcrTraceRequest, sim: EcrSimulator) => Promise<unknown>;
}>;

type Fixture = {
  tenant: IsolatedTenant;
  ctx: ScopedTenantContext;
  actor: string;
  sim: EcrSimulator;
  terminalId: string;
  agent: ReturnType<typeof createEdcAgent>;
};

/**
 * Providers may answer with RAW objects (as a real adapter parsing a wire
 * frame might); the agent must sanitise/reject them itself.
 */
async function fixture(
  tenant: IsolatedTenant,
  actor: string,
  over: Over = {},
  saleTimeoutMs = 50,
): Promise<Fixture> {
  const sim = new EcrSimulator("bca");
  const provider: EdcProvider = {
    bank: sim.bank,
    capabilities: sim.capabilities,
    sale: (r) =>
      over.sale ? (over.sale(r, sim) as Promise<EcrResult>) : sim.sale(r),
    cancel: (r) =>
      over.cancel ? (over.cancel(r, sim) as Promise<EcrResult>) : sim.cancel(r),
    inquiry: (r) =>
      over.inquiry
        ? (over.inquiry(r, sim) as Promise<EcrInquiryResult>)
        : sim.inquiry(r),
    void: (r) => sim.void(r),
  };
  const registry = new EdcProviderRegistry();
  registry.register(provider);
  const terminalId = await seedTerminal(tenant);
  const ctx = ctxFor(tenant);
  const agent = createEdcAgent({
    db,
    registry,
    saleTimeoutMs,
    inquiryTimeoutMs: 50,
    cancelTimeoutMs: 50,
  });
  startedAgents.push({ agent, ctx });
  await agent.start(ctx);
  return { tenant, ctx, actor, sim, terminalId, agent };
}

const request = (f: Fixture): EdcPaymentRequest =>
  ({
    tenantId: tenantIdSchema.parse(f.tenant.tenantId),
    outletId: outletIdSchema.parse(f.tenant.outletId),
    terminalId: f.terminalId,
    reference: `BILL-${randomUUID().slice(0, 8)}`,
    idempotencyKey: randomUUID(),
    amountIdr: idr(AMOUNT),
    method: "card",
  }) as EdcPaymentRequest;

const pay = async (f: Fixture, req: EdcPaymentRequest) => {
  await ensureBill(owner, req);
  return f.agent.requestPayment(f.ctx, f.actor, req);
};

const refTo = (f: Fixture, tx: Pick<EdcTransaction, "id">) => ({
  tenantId: tenantIdSchema.parse(f.tenant.tenantId),
  outletId: outletIdSchema.parse(f.tenant.outletId),
  transactionId: tx.id,
});

/** A raw approved answer whose every free field carries card data. */
const panLadenApproval = (r: EcrTraceRequest | EcrSaleRequest) => ({
  outcome: "approved",
  amountIdr: AMOUNT,
  trace: r.trace,
  approvalCode: "AP1234",
  responseCode: "00",
  cardType: PAN_PLAIN,
  message: `CARD ${PAN_SPACED} / ${PAN_DASHED} / ${PAN_MULTI} / ${PAN_MIXED} / ${PAN_12} APPROVED`,
  rrn: PAN_PLAIN,
  invoiceNo: `A${PAN_PLAIN}`,
  batchNo: `${PAN_OTHER}XY`,
});

function expectDtoClean(tx: EdcTransaction): void {
  expectNoPan("returned transaction", serialise(tx));
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenantA = await createIsolatedTenant(`edc-pl-a-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`edc-pl-b-${randomUUID().slice(0, 6)}`);
  cashierA = await staffUser(tenantA, "EDC PanLog Kasir A");
  cashierB = await staffUser(tenantB, "EDC PanLog Kasir B");
});

afterAll(async () => {
  await owner.query(
    "UPDATE tenants SET created_by = $2 WHERE id = ANY($1::uuid[])",
    [[tenantA.tenantId, tenantB.tenantId], randomUUID()],
  );
  await owner.end();
});

describe("EDC agent never logs or stores a card number (legend-5gub)", () => {
  it("PAN-01 an approved sale whose answer carries a PAN in every free field logs and stores none", async () => {
    const f = await fixture(tenantA, cashierA, {
      sale: async (r) => panLadenApproval(r),
    });
    const tx = await pay(f, request(f));

    expect(tx.status).toBe("approved");
    expect(tx.cardType).toBe("UNKNOWN");
    expect(tx.rrn).toBeNull();
    expect(tx.invoiceNo).toBeNull();
    expect(tx.batchNo).toBeNull();
    expect(tx.message).toContain("[disamarkan]");
    expectDtoClean(tx);

    expect(captured.length).toBeGreaterThan(0); // the agent did log something
    expectNoPan("log output", loggedText());
    const rows = await ledger(f.tenant);
    expect(rows).toHaveLength(1);
    expectLedgerClean(rows);
    expect(captured.some((c) => c.level === "child")).toBe(false);
  });

  it("PAN-02 an invalid answer (full PAN in maskedPan, extra track field) is rejected: row unknown, nothing logged or stored", async () => {
    const f = await fixture(tenantA, cashierA, {
      sale: async (r) => ({
        ...panLadenApproval(r),
        maskedPan: PAN_PLAIN, // schema must reject a full PAN
        track2: `${PAN_PLAIN}=25121010000000000`,
      }),
    });
    const tx = await pay(f, request(f));

    expect(tx.status).toBe("unknown");
    expect(tx.maskedPan).toBeNull();
    expectDtoClean(tx);
    expect(loggedMessages()).toContain("EDC sale gave no answer");
    expectNoPan("log output", loggedText());
    expectLedgerClean(await ledger(f.tenant));
  });

  it("PAN-03 a transport error whose message holds a PAN: row unknown, PAN neither logged nor stored", async () => {
    const f = await fixture(tenantA, cashierA, {
      sale: async () => {
        throw new EcrTransportError(
          "protocol",
          `bad frame for card ${PAN_SPACED} (${PAN_PLAIN}) ${PAN_MULTI} ${PAN_MIXED} ${PAN_12}`,
        );
      },
    });
    const tx = await pay(f, request(f));

    expect(tx.status).toBe("unknown");
    expectDtoClean(tx);
    expect(loggedMessages()).toContain("EDC sale gave no answer");
    expectNoPan("log output", loggedText());
    expectLedgerClean(await ledger(f.tenant));
  });

  it("PAN-04 a plain Error carrying a PAN is not logged either", async () => {
    const f = await fixture(tenantA, cashierA, {
      sale: async () => {
        throw new Error(
          `socket reset, last frame: ${PAN_DASHED} ${PAN_MIXED} ${PAN_12}`,
        );
      },
    });
    const tx = await pay(f, request(f));

    expect(tx.status).toBe("unknown");
    expectNoPan("log output", loggedText());
    expectLedgerClean(await ledger(f.tenant));
  });

  it("PAN-05 an inquiry that answers with a PAN-laden approval resolves the row without logging or storing the PAN", async () => {
    const f = await fixture(tenantA, cashierA, {
      inquiry: async (r) => panLadenApproval(r),
    });
    f.sim.next(f.terminalId, "timeout_after_charge");
    const first = await pay(f, request(f));
    expect(first.status).toBe("unknown");

    const resolved = await f.agent.inquire(f.ctx, f.actor, refTo(f, first));
    expect(resolved.status).toBe("approved");
    expect(resolved.cardType).toBe("UNKNOWN");
    expectDtoClean(resolved);
    expectNoPan("log output", loggedText());
    expectLedgerClean(await ledger(f.tenant));
  });

  it("PAN-06 an inquiry that throws or answers invalidly with a PAN stays unknown and is not logged", async () => {
    let mode: "throw" | "invalid" = "throw";
    const f = await fixture(tenantA, cashierA, {
      inquiry: async (r) => {
        if (mode === "throw")
          throw new EcrTransportError(
            "disconnected",
            `lost link, card ${PAN_PLAIN}`,
          );
        return { ...panLadenApproval(r), maskedPan: PAN_SPACED };
      },
    });
    f.sim.next(f.terminalId, "timeout_after_charge");
    const first = await pay(f, request(f));
    expect(first.status).toBe("unknown");

    const thrown = await f.agent.inquire(f.ctx, f.actor, refTo(f, first));
    expect(thrown.status).toBe("unknown");
    mode = "invalid";
    const invalid = await f.agent.inquire(f.ctx, f.actor, refTo(f, first));
    expect(invalid.status).toBe("unknown");

    expect(loggedMessages()).toContain("EDC inquiry gave no answer");
    expectNoPan("log output", loggedText());
    expectLedgerClean(await ledger(f.tenant));
  });

  it("PAN-07 a cancel that fails with a PAN in its error is not logged", async () => {
    const f = await fixture(tenantA, cashierA, {
      cancel: async () => {
        throw new EcrTransportError("timeout", `no answer for ${PAN_PLAIN}`);
      },
    });
    f.sim.next(f.terminalId, "timeout_after_charge");
    const first = await pay(f, request(f));
    expect(first.status).toBe("unknown");

    // Assumption: cancelling an unknown row asks the terminal; the failing
    // adapter leaves it unknown (or the agent refuses). Either way: no PAN.
    await f.agent
      .cancel(f.ctx, f.actor, refTo(f, first))
      .catch(() => undefined);
    expect(loggedMessages()).toContain("EDC cancel gave no answer");
    expectNoPan("log output", loggedText());
    expectLedgerClean(await ledger(f.tenant));
  });

  it("PAN-08 a late PAN-laden approval after a cancel flags the row without logging or storing the PAN", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const f = await fixture(
      tenantA,
      cashierA,
      {
        sale: async (r, sim) => {
          await sim.sale(r); // held until the cancel resolves it
          await gate;
          return panLadenApproval(r);
        },
      },
      10_000,
    );
    f.sim.next(f.terminalId, "hold");
    const req = request(f);
    const selling = pay(f, req);
    let rowId = "";
    await vi.waitFor(async () => {
      const rows = await ledger(f.tenant);
      const row = rows.find((x) => x.reference === req.reference);
      expect(row?.status).toBe("pending");
      expect(f.sim.callsFor(f.terminalId).sale).toBe(1);
      rowId = row!.id as string;
    });
    const cancelled = await f.agent.cancel(
      f.ctx,
      f.actor,
      refTo(f, { id: rowId }),
    );
    expect(cancelled.status).toBe("cancelled");

    open();
    const sold = await selling;
    expect(sold.status).toBe("cancelled");
    expectDtoClean(sold);
    expect(loggedMessages()).toContain(
      "EDC approval arrived after the row was final: approved late",
    );
    expectNoPan("log output", loggedText());
    expectLedgerClean(await ledger(f.tenant));
  });

  it("PAN-09 the simulator's own pan_in_message scenario is masked in log, DTO and ledger", async () => {
    const f = await fixture(tenantA, cashierA);
    f.sim.next(f.terminalId, "pan_in_message");
    const tx = await pay(f, request(f));
    expect(tx.status).toBe("approved");
    expect(tx.message).toContain("[disamarkan]");
    expectDtoClean(tx);
    expectNoPan("log output", loggedText());
    expectLedgerClean(await ledger(f.tenant));
  });

  it("PAN-10 isolation: tenant A's PAN flows leave tenant B's rows untouched and tenant B's logs clean", async () => {
    const fb = await fixture(tenantB, cashierB);
    const bTx = await pay(fb, request(fb));
    expect(bTx.status).toBe("approved");
    const before = JSON.stringify(await ledger(tenantB));

    // One agent per outlet (advisory lock): switch the adapter behaviour.
    let mode: "approve" | "throw" = "approve";
    const fa = await fixture(tenantA, cashierA, {
      sale: async (r) => {
        if (mode === "throw")
          throw new EcrTransportError("protocol", `card ${PAN_PLAIN}`);
        return panLadenApproval(r);
      },
    });
    const aTx = await pay(fa, request(fa));
    expect(aTx.status).toBe("approved");
    mode = "throw";
    expect((await pay(fa, request(fa))).status).toBe("unknown");

    expect(JSON.stringify(await ledger(tenantB))).toBe(before);
    const bRows = await ledger(tenantB);
    expect(bRows.every((row) => row.tenant_id === tenantB.tenantId)).toBe(true);
    expect(bRows.some((row) => row.id === aTx.id)).toBe(false);
    expectLedgerClean(await ledger(tenantA));
    expectLedgerClean(bRows);
    expectNoPan("log output", loggedText());
  });
});
