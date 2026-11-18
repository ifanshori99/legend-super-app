// Support session read-only vs Kas & Bank mutations (follow-up to the 643 cash
// work, tier K: money + auth). The read-only guard is global (PRD v1.7 §3 F4
// Support Access: "read-only secara default"); support-session-readonly.test.ts
// proves it on /api/org and /api/access. This file proves it on the money
// surface: under a read_only support grant every cash/bank mutation answers
// 403 SUPPORT_ACCESS_READ_ONLY and the database is left untouched.
//
// Written from docs/briefs and the shared endpoint contract
// (packages/shared/src/accounting/endpoints.ts), not from the implementation.
//
// Assumptions (spec silent, same as support-session-readonly.test.ts):
// - Refusal is HTTP 403 with body.error.code = "SUPPORT_ACCESS_READ_ONLY".
// - "Nothing changed" is read straight from PostgreSQL as the migration owner:
//   rows of cash_bank_entries / journal_entries / bank_accounts /
//   petty_cash_entries+funds / cash_deposits of this file's own world.
// - Control 2: the same approve under a read_write grant may fail for other
//   business reasons; only the SUPPORT_ACCESS_* code must be absent.
// - The impersonated tenant user is a tenant-wide Owner + finance user, so the
//   permission layer would allow the call: the refusal can only come from the
//   support-session guard.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  requestSupportAccessInputSchema,
  requestSupportWriteAccessInputSchema,
} from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import {
  approveSupportAccessRequest,
  requestSupportAccess,
  requestSupportWriteAccess,
  SUPPORT_ACCESS_WRITE_MAX_MINUTES,
} from "../services/platform-support.service.ts";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers.ts";
import {
  closeKit,
  daysAgo,
  key,
  makeOutlet,
  makeWorld,
  owner,
  short,
  signedIn,
  tenantId,
  type Session,
  type World,
} from "./helpers/cash-bank-world.ts";
import { approveChainLevelAs } from "./helpers/cash-out-chain.ts";

const app = createApp();
const BASE = "/api/accounting";
const ENTRIES = `${BASE}/cash-bank/entries`;
const REASON = "Menelusuri selisih kas dan bank tenant atas permintaan.";
const DEFAULT_LIMIT = 5_000_000;

type Client = ReturnType<typeof agent>;
type Admin = { client: Client; userId: string };

let world: World;
let outletId: string;
let creator: Session; // files the pending cash out (cannot decide its own)
let tenantUserId: string;
let tenantEmail: string;
const adminIds: string[] = [];
let support: Client; // impersonated session under a read_only grant

// ---- support session setup (mirrors support-session-readonly.test.ts) ------

async function newSuperAdmin(): Promise<Admin> {
  const client = agent(app);
  const email = await signUp(client, "Super Admin Kas");
  await setRole(email, "admin");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  await owner.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
    userId,
  ]);
  adminIds.push(userId);
  return { client, userId };
}

async function impersonate(admin: Admin): Promise<Client> {
  const response = await admin.client
    .post("/api/auth/admin/impersonate-user")
    .set(originHeader)
    .send({ userId: tenantUserId });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  await verifySessionMfa(tenantEmail);
  return admin.client;
}

async function readOnlySupport(): Promise<Client> {
  const admin = await newSuperAdmin();
  const now = new Date();
  await requestSupportAccess({
    tenantId,
    actorUserId: admin.userId,
    request: requestSupportAccessInputSchema.parse({
      reason: REASON,
      mfaCode: "123456",
    }),
    mfaVerifiedAt: now.toISOString(),
    now,
  });
  return impersonate(admin);
}

async function readWriteSupport(): Promise<Client> {
  const admin = await newSuperAdmin();
  const now = new Date();
  const request = await requestSupportWriteAccess({
    tenantId,
    actorUserId: admin.userId,
    request: requestSupportWriteAccessInputSchema.parse({
      reason: REASON,
      mfaCode: "123456",
      durationMinutes: SUPPORT_ACCESS_WRITE_MAX_MINUTES,
    }),
    mfaVerifiedAt: now.toISOString(),
    now,
  });
  const approved = await approveSupportAccessRequest(
    establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "session" }),
      { kind: "tenant" },
    ),
    { userId: tenantUserId },
    request.id,
    now,
  );
  expect(approved.status).toBe("approved");
  return impersonate(admin);
}

// ---- request bodies --------------------------------------------------------

const cashOutBody = (extra: Record<string, unknown> = {}) => ({
  kind: "cash_out",
  legalEntityId: world.entityId,
  bankAccountId: world.bankAccountA,
  counterAccountId: world.gl.expense,
  amountIdr: DEFAULT_LIMIT + 1, // strictly above the limit: pending approval
  entryDate: daysAgo(1),
  description: "Bayar supplier besar",
  reference: `REF-${short()}`,
  idempotencyKey: key(),
  ...extra,
});

async function newPendingEntry(): Promise<string> {
  const res = await creator.client
    .post(ENTRIES)
    .set(originHeader)
    .send(cashOutBody());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.data.status).toBe("pending_approval");
  return res.body.data.id as string;
}

// ---- DB state (migration owner, this file's own world only) ----------------

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(sql, params);
  return Number(rows[0]!.n);
}

async function snapshot() {
  return {
    entries: await count(
      "SELECT count(*)::text AS n FROM cash_bank_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantId, world.entityId],
    ),
    journals: await count(
      "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantId, world.entityId],
    ),
    bankAccounts: await count(
      "SELECT count(*)::text AS n FROM bank_accounts WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantId, world.entityId],
    ),
    pettyEntries: await count(
      "SELECT count(*)::text AS n FROM petty_cash_entries WHERE tenant_id = $1 AND outlet_id = $2",
      [tenantId, outletId],
    ),
    pettyFunds: await count(
      "SELECT count(*)::text AS n FROM petty_cash_funds WHERE tenant_id = $1 AND outlet_id = $2",
      [tenantId, outletId],
    ),
    deposits: await count(
      "SELECT count(*)::text AS n FROM cash_deposits WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantId, world.entityId],
    ),
  };
}

async function entryRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    approver_id: string | null;
    decided_at: string | null;
    journal_entry_id: string | null;
  }>(
    `SELECT status, approver_id, decided_at::text, journal_entry_id
       FROM cash_bank_entries WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function expectReadOnly(res: {
  status: number;
  body: { error?: { code?: string } };
}) {
  expect(res.status, JSON.stringify(res.body)).toBe(403);
  expect(res.body.error?.code).toBe("SUPPORT_ACCESS_READ_ONLY");
}

// ---- fixtures --------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  world = await makeWorld();
  outletId = await makeOutlet(world.entityId);
  creator = await signedIn(app, "Support cash creator", [
    { role: "finance", outletId: null },
  ]);

  // The tenant user the support admin impersonates: tenant-wide Owner (needed
  // to approve a read_write grant) and finance (cash/bank permissions).
  const client = agent(app);
  tenantEmail = await signUp(client, "Pemilik Kas");
  tenantUserId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  for (const template of ["owner", "finance"])
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
        WHERE tenant_id = $1 AND template_key = $3`,
      [tenantId, tenantUserId, template],
    );
  await verifySessionMfa(tenantEmail);

  support = await readOnlySupport();
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM support_access_grants WHERE super_admin_user_id = ANY($1::text[])",
    [adminIds],
  );
  await owner.query(
    "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
    [adminIds],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
    [tenantId, tenantUserId],
  );
  await closeKit();
});

// ---- tests -----------------------------------------------------------------

describe("TEN-04 support read_only session vs cash/bank mutations", () => {
  it("control: reading cash/bank entries passes under read_only", async () => {
    const id = await newPendingEntry();
    const res = await support.get(ENTRIES).query({
      legalEntityId: world.entityId,
      from: daysAgo(30),
      to: daysAgo(0),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.map((row: { id: string }) => row.id)).toContain(id);
    expect((await support.get(`${ENTRIES}/${id}`)).status).toBe(200);
  });

  it("approving a pending cash out is refused and the entry stays pending with no journal", async () => {
    const id = await newPendingEntry();
    const before = await snapshot();
    expectReadOnly(
      await support
        .post(`${ENTRIES}/${encodeURIComponent(id)}/approve`)
        .set(originHeader)
        .send({}),
    );
    const row = await entryRow(id);
    expect(row.status).toBe("pending_approval");
    expect(row.approver_id).toBeNull();
    expect(row.decided_at).toBeNull();
    expect(row.journal_entry_id).toBeNull();
    expect(await snapshot()).toEqual(before);
  });

  it("rejecting a pending cash out is refused and the entry stays pending", async () => {
    const id = await newPendingEntry();
    const before = await snapshot();
    expectReadOnly(
      await support
        .post(`${ENTRIES}/${encodeURIComponent(id)}/reject`)
        .set(originHeader)
        .send({ reason: "Dukungan mencoba menolak" }),
    );
    const row = await entryRow(id);
    expect(row.status).toBe("pending_approval");
    expect(row.approver_id).toBeNull();
    expect(row.decided_at).toBeNull();
    expect(await snapshot()).toEqual(before);
  });

  it("creating a cash-bank entry is refused (cash out, cash in and transfer) and nothing is stored", async () => {
    const before = await snapshot();
    const bodies = [
      cashOutBody({ amountIdr: 10_000 }),
      cashOutBody({
        kind: "cash_in",
        counterAccountId: world.gl.revenue,
        amountIdr: 10_000,
      }),
      {
        kind: "transfer",
        legalEntityId: world.entityId,
        fromBankAccountId: world.bankAccountA,
        toBankAccountId: world.bankAccountB,
        amountIdr: 10_000,
        entryDate: daysAgo(1),
        description: "Pindah rekening",
        reference: `REF-${short()}`,
        idempotencyKey: key(),
      },
    ];
    for (const body of bodies)
      expectReadOnly(await support.post(ENTRIES).set(originHeader).send(body));
    expect(await snapshot()).toEqual(before);
  });

  it("a petty cash top-up and a return are refused and no fund or ledger row appears", async () => {
    const before = await snapshot();
    for (const kind of ["topup", "return"])
      expectReadOnly(
        await support
          .post(`${BASE}/petty-cash/movements`)
          .set(originHeader)
          .send({
            kind,
            outletId,
            bankAccountId: world.bankAccountA,
            amountIdr: 100_000,
            description: "Isi kas kecil oleh dukungan",
            idempotencyKey: key(),
          }),
      );
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(after.pettyFunds).toBe(0);
    expect(after.pettyEntries).toBe(0);
  });

  it("creating a bank account is refused and no account is stored", async () => {
    const before = await snapshot();
    expectReadOnly(
      await support
        .post(`${BASE}/bank-accounts`)
        .set(originHeader)
        .send({
          legalEntityId: world.entityId,
          bank: "BCA",
          accountName: `Rekening dukungan ${short()}`,
          accountNumber: String(Math.floor(Math.random() * 9e11) + 1e11),
          glAccountId: world.gl.bankA,
        }),
    );
    expect(await snapshot()).toEqual(before);
  });

  it("recording a cash deposit is refused and no deposit is stored", async () => {
    const before = await snapshot();
    expectReadOnly(
      await support
        .post(`${BASE}/cash-deposits`)
        .set(originHeader)
        .send({
          outletId,
          bankAccountId: world.bankAccountA,
          amountIdr: 250_000,
          coversFrom: daysAgo(2),
          coversTo: daysAgo(1),
          depositedAt: new Date().toISOString(),
          slipReference: `SLIP-${short()}`,
          idempotencyKey: key(),
        }),
    );
    expect(await snapshot()).toEqual(before);
  });

  it("control 2: under a read_write grant the same approve is not refused by the support guard", async () => {
    const id = await newPendingEntry();
    const writer = await readWriteSupport();
    // The direct approve only posts once the chain is approved (legend-3bkvl).
    await approveChainLevelAs({ client: writer, userId: tenantUserId }, id);
    const res = await writer
      .post(`${ENTRIES}/${encodeURIComponent(id)}/approve`)
      .set(originHeader)
      .send({});
    // May be 200 or a business refusal; never a support-session refusal.
    expect(res.body?.error?.code ?? "").not.toMatch(/^SUPPORT_ACCESS_/);
    expect(res.status).toBeLessThan(500);
    // The impersonated user is not the creator, so approval is expected to work.
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await entryRow(id)).status).toBe("approved");
  });
});
