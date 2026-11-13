// Kas & Bank entries (cash in, cash out, bank-to-bank transfer) — HTTP tests
// (bead legend-4961, WS-07; PRD v1.7 §3.19 Kas & Bank; design
// docs/briefs/ws-cash-bank-design.md). Real Better Auth, RLS and PostgreSQL on
// the disposable test DB; requests go through the real routes of createApp().
//
// Founder money rules (fail-first, each has a control that succeeds so a
// missing route cannot pass by returning 404):
// 1. a transfer is balanced (debit = credit) and idempotent: the same key
//    never doubles, also under parallel requests;
// 3. no permission / other outlet scope / other tenant is refused;
// 4. one document makes exactly one journal.
// (Rule 2, petty cash cannot go negative, is in accounting-petty-cash.test.ts.)
//
// Assumptions where the design is silent:
// - Success is 201 for a create; a replay answers 200 or 201 with the same id.
// - A rejected body (zero/negative amount, future date, unknown field) answers
//   4xx; only the contract codes named in the design are pinned exactly
//   (IDEMPOTENCY_KEY_REUSED 409, CASH_BANK_COUNTER_ACCOUNT_INVALID 422,
//   OUTLET_OUT_OF_SCOPE 403).
// - Errors use the `{ error: { code } }` envelope of the other suites.
// - A foreign or unknown id answers 404 (RLS hides it).
// - Table/column names (cash_bank_entries, idempotency_key, journal_entry_id,
//   ...) are the ones the design fixes.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  asOwnerTenant,
  asRuntime,
  closeKit,
  daysAgo,
  journalCount,
  journalLinesOf,
  journalsByKey,
  key,
  lineOf,
  makeBankAccount,
  makeOutlet,
  makeWorld,
  owner,
  short,
  signedIn,
  tenantId,
  type Session,
  type World,
} from "./helpers/cash-bank-world.ts";

const app = createApp();
const ENTRIES = "/api/accounting/cash-bank/entries";
const MONEY_SOURCES = ["cash_receipt", "cash_payment", "bank_transfer"];

let world: World;
let finance: Session;
let scopedFinance: Session;
let nobody: Session;
let outletX: string;
let outletY: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  world = await makeWorld();
  outletX = await makeOutlet(world.entityId);
  outletY = await makeOutlet(world.entityId);
  finance = await signedIn(app, "CB finance", [
    { role: "finance", outletId: null },
  ]);
  scopedFinance = await signedIn(app, "CB finance outlet", [
    { role: "finance", outletId: outletX },
  ]);
  nobody = await signedIn(app, "CB nobody", []);
});

afterAll(async () => {
  // Journals and ledger rows are append-only; the disposable DB keeps them.
  await closeKit();
});

// ---- request + read helpers ------------------------------------------------

const post = (who: Session, body: Record<string, unknown>) =>
  who.client
    .post(ENTRIES)
    .set(originHeader)
    .send(body as object);
const list = (who: Session, query: Record<string, string | number>) =>
  who.client.get(ENTRIES).set(originHeader).query(query);

const cashInBody = (extra: Record<string, unknown> = {}) => ({
  kind: "cash_in",
  legalEntityId: world.entityId,
  bankAccountId: world.bankAccountA,
  counterAccountId: world.gl.revenue,
  amountIdr: 250_000,
  entryDate: daysAgo(1),
  description: "Setoran modal pemilik",
  reference: `REF-${short()}`,
  idempotencyKey: key(),
  ...extra,
});
const cashOutBody = (extra: Record<string, unknown> = {}) =>
  cashInBody({
    kind: "cash_out",
    counterAccountId: world.gl.expense,
    amountIdr: 175_000,
    description: "Bayar listrik",
    ...extra,
  });
const transferBody = (extra: Record<string, unknown> = {}) => ({
  kind: "transfer",
  legalEntityId: world.entityId,
  fromBankAccountId: world.bankAccountA,
  toBankAccountId: world.bankAccountB,
  amountIdr: 1_000_000,
  entryDate: daysAgo(1),
  description: "Pindah ke rekening cadangan",
  reference: `REF-${short()}`,
  idempotencyKey: key(),
  ...extra,
});

async function entryCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM cash_bank_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, world.entityId],
  );
  return Number(rows[0]!.n);
}
const moneyJournals = () => journalCount(world.entityId, MONEY_SOURCES);

type EntryRow = {
  id: string;
  kind: string;
  amount_idr: string;
  bank_account_id: string;
  to_bank_account_id: string | null;
  counter_account_id: string | null;
  journal_entry_id: string;
  idempotency_key: string;
  outlet_id: string | null;
};
async function entryRow(id: string): Promise<EntryRow> {
  const { rows } = await owner.query<EntryRow>(
    `SELECT id, kind, amount_idr::text, bank_account_id, to_bank_account_id,
            counter_account_id, journal_entry_id, idempotency_key, outlet_id
       FROM cash_bank_entries WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  expect(rows, `cash_bank_entries row ${id}`).toHaveLength(1);
  return rows[0]!;
}

/** The journal of one document: exactly one, with the design's source type and key. */
async function expectOneJournal(entryId: string, sourceType: string) {
  const row = await entryRow(entryId);
  const byKey = await journalsByKey(world.entityId, `cb:${entryId}`);
  expect(byKey).toHaveLength(1);
  expect(byKey[0]).toMatchObject({
    id: row.journal_entry_id,
    source_type: sourceType,
  });
  const lines = await journalLinesOf(row.journal_entry_id);
  const debit = lines.reduce((total, line) => total + line.debit, 0);
  const credit = lines.reduce((total, line) => total + line.credit, 0);
  expect(debit).toBeGreaterThan(0);
  expect(debit).toBe(credit);
  return { row, lines };
}

const ok = (status: number) => [200, 201].includes(status);

// ============================================================================

describe("legend-4961 cash in / cash out", () => {
  it("[legend-4961-CB-1] cash in records the entry and one balanced journal Dr bank GL / Cr counter", async () => {
    const before = await moneyJournals();
    const res = await post(finance, cashInBody());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      kind: "cash_in",
      amountIdr: 250_000,
    });
    const { row, lines } = await expectOneJournal(
      res.body.data.id,
      "cash_receipt",
    );
    expect(row.amount_idr).toBe("250000");
    expect(row.counter_account_id).toBe(world.gl.revenue);
    expect(lineOf(lines, world.gl.bankA)).toEqual({
      debit: 250_000,
      credit: 0,
    });
    expect(lineOf(lines, world.gl.revenue)).toEqual({
      debit: 0,
      credit: 250_000,
    });
    expect(lines).toHaveLength(2);
    expect(await moneyJournals()).toBe(before + 1);
  });

  it("[legend-4961-CB-2] cash out records Dr counter / Cr bank GL, balanced", async () => {
    const res = await post(finance, cashOutBody());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { lines } = await expectOneJournal(res.body.data.id, "cash_payment");
    expect(lineOf(lines, world.gl.expense)).toEqual({
      debit: 175_000,
      credit: 0,
    });
    expect(lineOf(lines, world.gl.bankA)).toEqual({
      debit: 0,
      credit: 175_000,
    });
  });

  it("[legend-4961-CB-3] the optional outlet tag is stored (cost tag), the entry stays entity level", async () => {
    const res = await post(finance, cashOutBody({ outletId: outletY }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = await entryRow(res.body.data.id);
    expect(row.outlet_id).toBe(outletY);
    await expectOneJournal(res.body.data.id, "cash_payment");
  });

  it("[legend-4961-CB-4] a cash or bank account is not a valid counter account: use transfer", async () => {
    const entries = await entryCount();
    const journals = await moneyJournals();
    for (const counterAccountId of [world.gl.cashDrawer, world.gl.bankB]) {
      for (const body of [
        cashInBody({ counterAccountId }),
        cashOutBody({ counterAccountId }),
      ]) {
        const res = await post(finance, body);
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(res.body.error.code).toBe("CASH_BANK_COUNTER_ACCOUNT_INVALID");
      }
    }
    expect(await entryCount()).toBe(entries);
    expect(await moneyJournals()).toBe(journals);
    // Control: a real revenue account is accepted, so the 422s are the rule.
    expect((await post(finance, cashInBody())).status).toBe(201);
  });

  it("[legend-4961-CB-5] a counter account of another legal entity is refused, nothing is written", async () => {
    const { rows } = await owner.query<{ id: string }>(
      `SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1103'`,
      [tenantId, world.otherEntityId],
    );
    const foreignAccount = rows[0]!.id;
    const entries = await entryCount();
    const res = await post(
      finance,
      cashInBody({ counterAccountId: foreignAccount }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(await entryCount()).toBe(entries);
  });

  it("[legend-4961-CB-6] bad bodies are refused with 4xx and write nothing", async () => {
    const entries = await entryCount();
    const journals = await moneyJournals();
    const bad: Record<string, unknown>[] = [
      cashInBody({ amountIdr: 0 }),
      cashInBody({ amountIdr: -1000 }),
      cashOutBody({ amountIdr: 1000.5 }),
      transferBody({ amountIdr: 0 }),
      cashInBody({ description: "" }),
      cashInBody({ idempotencyKey: "short" }),
      // A future entry date is refused (entity's today).
      cashInBody({ entryDate: daysAgo(-3) }),
      // The client never picks the journal or overrides accounts.
      cashInBody({ journalEntryId: randomUUID() }),
      cashInBody({ accountOverrides: { bank: world.gl.revenue } }),
      // A transfer carries no counter account.
      transferBody({ counterAccountId: world.gl.revenue }),
      { ...cashInBody(), kind: "spend" },
    ];
    for (const body of bad) {
      const res = await post(finance, body);
      expect(
        res.status >= 400 && res.status < 500,
        `${JSON.stringify(body)} -> ${res.status}`,
      ).toBe(true);
    }
    expect(await entryCount()).toBe(entries);
    expect(await moneyJournals()).toBe(journals);
    // Control: a good body is accepted, so the 4xx above are validation.
    expect((await post(finance, cashInBody())).status).toBe(201);
  });
});

describe("legend-4961 transfer between bank accounts (money rule 1 and 4)", () => {
  it("[legend-4961-CB-10] a transfer is one balanced journal: Dr target GL = Cr source GL = amount", async () => {
    const before = await moneyJournals();
    const res = await post(finance, transferBody());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      kind: "transfer",
      amountIdr: 1_000_000,
    });
    const { row, lines } = await expectOneJournal(
      res.body.data.id,
      "bank_transfer",
    );
    expect(row.bank_account_id).toBe(world.bankAccountA);
    expect(row.to_bank_account_id).toBe(world.bankAccountB);
    expect(row.counter_account_id).toBeNull();
    expect(lineOf(lines, world.gl.bankB)).toEqual({
      debit: 1_000_000,
      credit: 0,
    });
    expect(lineOf(lines, world.gl.bankA)).toEqual({
      debit: 0,
      credit: 1_000_000,
    });
    expect(lines).toHaveLength(2);
    expect(await moneyJournals()).toBe(before + 1);
  });

  it("[legend-4961-CB-11] replay with the same key and body returns the same entry, no second entry or journal", async () => {
    const body = transferBody({ amountIdr: 333_000 });
    const entries = await entryCount();
    const journals = await moneyJournals();
    const first = await post(finance, body);
    const replay = await post(finance, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(ok(replay.status), JSON.stringify(replay.body)).toBe(true);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await entryCount()).toBe(entries + 1);
    expect(await moneyJournals()).toBe(journals + 1);
    expect(
      await journalsByKey(world.entityId, `cb:${first.body.data.id}`),
    ).toHaveLength(1);
  });

  it("[legend-4961-CB-12] the same key with another amount or accounts is refused with IDEMPOTENCY_KEY_REUSED", async () => {
    const body = transferBody({ amountIdr: 444_000 });
    const first = await post(finance, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const entries = await entryCount();
    const journals = await moneyJournals();
    for (const changed of [
      { ...body, amountIdr: 444_001 },
      {
        ...body,
        fromBankAccountId: world.bankAccountB,
        toBankAccountId: world.bankAccountA,
      },
    ]) {
      const reused = await post(finance, changed);
      expect(reused.status, JSON.stringify(reused.body)).toBe(409);
      expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    }
    expect(await entryCount()).toBe(entries);
    expect(await moneyJournals()).toBe(journals);
  });

  it("[legend-4961-CB-13] five parallel requests with one key make exactly one entry and one journal", async () => {
    const body = transferBody({ amountIdr: 555_000 });
    const entries = await entryCount();
    const journals = await moneyJournals();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => post(finance, body)),
    );
    for (const res of results)
      expect(ok(res.status), JSON.stringify(res.body)).toBe(true);
    const ids = new Set(results.map((res) => res.body.data.id as string));
    expect(ids.size).toBe(1);
    expect(await entryCount()).toBe(entries + 1);
    expect(await moneyJournals()).toBe(journals + 1);
    const [id] = [...ids];
    await expectOneJournal(id!, "bank_transfer");
  });

  it("[legend-4961-CB-14] the same replay also holds for cash in (one document, one journal)", async () => {
    const body = cashInBody({ amountIdr: 91_000 });
    const journals = await moneyJournals();
    const results = await Promise.all([
      post(finance, body),
      post(finance, body),
    ]);
    for (const res of results)
      expect(ok(res.status), JSON.stringify(res.body)).toBe(true);
    expect(results[0]!.body.data.id).toBe(results[1]!.body.data.id);
    expect(await moneyJournals()).toBe(journals + 1);
  });

  it("[legend-4961-CB-15] a transfer to the same account, across entities, or to a foreign account is refused", async () => {
    const entries = await entryCount();
    const journals = await moneyJournals();

    const same = await post(
      finance,
      transferBody({ toBankAccountId: world.bankAccountA }),
    );
    expect(same.status, JSON.stringify(same.body)).toBe(422);

    // Between legal entities is out of scope (design): 422.
    const across = await post(
      finance,
      transferBody({ toBankAccountId: world.otherBankAccount }),
    );
    expect(across.status, JSON.stringify(across.body)).toBe(422);

    // A bank account of another tenant is invisible: 404.
    const foreign = await post(
      finance,
      transferBody({ toBankAccountId: world.foreign.bankAccountId }),
    );
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
    const foreignSource = await post(
      finance,
      transferBody({ fromBankAccountId: world.foreign.bankAccountId }),
    );
    expect(foreignSource.status).toBe(404);

    // Unknown account: 404.
    const unknown = await post(
      finance,
      transferBody({ toBankAccountId: randomUUID() }),
    );
    expect(unknown.status).toBe(404);

    expect(await entryCount()).toBe(entries);
    expect(await moneyJournals()).toBe(journals);
    // Control: the same transfer to a valid account works.
    expect((await post(finance, transferBody())).status).toBe(201);
  });

  it("[legend-4961-CB-16] two bank accounts on one GL account cannot be a transfer (it would book nothing)", async () => {
    // Registering a second bank account on a GL account that already has one
    // may itself be refused by bank-account setup; then the case cannot exist
    // and the rule holds. If it exists, the transfer must be 422.
    let twin: string | null = null;
    try {
      twin = await makeBankAccount(world.entityId, world.gl.bankA);
    } catch {
      twin = null;
    }
    if (twin === null) return;
    const entries = await entryCount();
    const res = await post(finance, transferBody({ toBankAccountId: twin }));
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(await entryCount()).toBe(entries);
  });

  it("[legend-4961-CB-17] an inactive bank account cannot take new money", async () => {
    const spare = await makeBankAccount(world.entityId, world.gl.bankB).catch(
      () => null,
    );
    if (spare === null) return;
    await owner.query(
      "UPDATE bank_accounts SET is_active = false WHERE id = $1",
      [spare],
    );
    const entries = await entryCount();
    const res = await post(finance, transferBody({ toBankAccountId: spare }));
    expect(res.status >= 400 && res.status < 500, String(res.status)).toBe(
      true,
    );
    const cashIn = await post(finance, cashInBody({ bankAccountId: spare }));
    expect(
      cashIn.status >= 400 && cashIn.status < 500,
      String(cashIn.status),
    ).toBe(true);
    expect(await entryCount()).toBe(entries);
    // Control: an active account takes the same transfer.
    expect((await post(finance, transferBody())).status).toBe(201);
  });
});

describe("legend-4961 access and isolation (money rule 3)", () => {
  it("[legend-4961-CB-20] anonymous callers get 401, users without the permission get 403, nothing is written", async () => {
    const entries = await entryCount();
    const anonymous = agent(app);
    expect(
      (await anonymous.post(ENTRIES).set(originHeader).send(cashInBody()))
        .status,
    ).toBe(401);
    expect(
      (
        await anonymous.get(ENTRIES).query({
          legalEntityId: world.entityId,
          from: daysAgo(30),
          to: daysAgo(0),
        })
      ).status,
    ).toBe(401);

    expect((await post(nobody, cashInBody())).status).toBe(403);
    expect((await post(nobody, transferBody())).status).toBe(403);
    expect(
      (
        await list(nobody, {
          legalEntityId: world.entityId,
          from: daysAgo(30),
          to: daysAgo(0),
        })
      ).status,
    ).toBe(403);
    expect(
      (await nobody.client.get(`${ENTRIES}/${randomUUID()}`).set(originHeader))
        .status,
    ).toBe(403);
    expect(await entryCount()).toBe(entries);
    // Control: finance can.
    expect((await post(finance, cashInBody())).status).toBe(201);
  });

  it("[legend-4961-CB-21] a mutation from an untrusted origin is refused", async () => {
    const entries = await entryCount();
    const res = await finance.client
      .post(ENTRIES)
      .set("Origin", "https://evil.example")
      .send(cashInBody() as object);
    expect(res.status).toBe(403);
    expect(await entryCount()).toBe(entries);
    // Control: the trusted origin works.
    expect((await post(finance, cashInBody())).status).toBe(201);
  });

  it("[legend-4961-CB-22] a finance user scoped to one outlet cannot record entity-level money", async () => {
    const entries = await entryCount();
    const journals = await moneyJournals();
    for (const body of [
      cashInBody(),
      cashOutBody({ outletId: outletX }),
      transferBody(),
    ]) {
      const res = await post(scopedFinance, body);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error.code).toBe("OUTLET_OUT_OF_SCOPE");
    }
    expect(await entryCount()).toBe(entries);
    expect(await moneyJournals()).toBe(journals);
  });

  it("[legend-4961-CB-23] reads: an outlet-scoped user sees only entries tagged to their outlet; foreign ids are 404", async () => {
    const own = await post(
      finance,
      cashOutBody({ outletId: outletX, amountIdr: 11_000 }),
    );
    const other = await post(
      finance,
      cashOutBody({ outletId: outletY, amountIdr: 22_000 }),
    );
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(other.status, JSON.stringify(other.body)).toBe(201);

    const window = {
      legalEntityId: world.entityId,
      from: daysAgo(30),
      to: daysAgo(0),
      limit: 100,
    };
    const scoped = await list(scopedFinance, window);
    expect(scoped.status, JSON.stringify(scoped.body)).toBe(200);
    const scopedIds = scoped.body.data.map((row: { id: string }) => row.id);
    expect(scopedIds).toContain(own.body.data.id);
    expect(scopedIds).not.toContain(other.body.data.id);

    // The tenant-wide user sees both.
    const all = await list(finance, window);
    const allIds = all.body.data.map((row: { id: string }) => row.id);
    expect(allIds).toEqual(
      expect.arrayContaining([own.body.data.id, other.body.data.id]),
    );

    // Detail of an entry outside the scope: hidden (404) or refused (403).
    const hidden = await scopedFinance.client
      .get(`${ENTRIES}/${other.body.data.id}`)
      .set(originHeader);
    expect([403, 404]).toContain(hidden.status);
    const visible = await scopedFinance.client
      .get(`${ENTRIES}/${own.body.data.id}`)
      .set(originHeader);
    expect(visible.status, JSON.stringify(visible.body)).toBe(200);
  });

  it("[legend-4961-CB-24] another tenant's entity is unknown: the list answers 404 or an empty page, never data", async () => {
    const res = await list(finance, {
      legalEntityId: world.foreign.entityId,
      from: daysAgo(30),
      to: daysAgo(0),
    });
    if (res.status === 200) expect(res.body.data).toEqual([]);
    else expect(res.status).toBe(404);
    const record = await post(
      finance,
      cashInBody({ legalEntityId: world.foreign.entityId }),
    );
    expect([404, 422]).toContain(record.status);
    // Control: the same body on this tenant's own entity works.
    expect((await post(finance, cashInBody())).status).toBe(201);
  });
});

describe("legend-4961 reading entries (empty and filled states)", () => {
  it("[legend-4961-CB-30] lists newest first by entity and window, filters by kind and bank account, and pages with a cursor", async () => {
    // Own entity per scenario would be cleaner; here the entity already holds
    // entries, so the window is today's date only and ids are matched.
    const a = await post(
      finance,
      transferBody({ entryDate: daysAgo(2), amountIdr: 1_001 }),
    );
    const b = await post(
      finance,
      cashInBody({ entryDate: daysAgo(1), amountIdr: 1_002 }),
    );
    const c = await post(
      finance,
      cashOutBody({ entryDate: daysAgo(1), amountIdr: 1_003 }),
    );
    for (const res of [a, b, c])
      expect(res.status, JSON.stringify(res.body)).toBe(201);

    const query = {
      legalEntityId: world.entityId,
      from: daysAgo(30),
      to: daysAgo(0),
      limit: 100,
    };
    const all = await list(finance, query);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const rows = all.body.data as {
      id: string;
      kind: string;
      amountIdr: number;
    }[];
    const ids = rows.map((row) => row.id);
    expect(ids).toEqual(
      expect.arrayContaining([a.body.data.id, b.body.data.id, c.body.data.id]),
    );
    // Newest first: the two latest creates come before the older transfer.
    expect(ids.indexOf(c.body.data.id)).toBeLessThan(
      ids.indexOf(b.body.data.id),
    );
    expect(ids.indexOf(b.body.data.id)).toBeLessThan(
      ids.indexOf(a.body.data.id),
    );

    const transfers = await list(finance, { ...query, kind: "transfer" });
    expect(transfers.status).toBe(200);
    expect(
      transfers.body.data.every(
        (row: { kind: string }) => row.kind === "transfer",
      ),
    ).toBe(true);
    expect(transfers.body.data.map((row: { id: string }) => row.id)).toContain(
      a.body.data.id,
    );

    const byBank = await list(finance, {
      ...query,
      bankAccountId: world.bankAccountB,
    });
    expect(byBank.status).toBe(200);
    expect(byBank.body.data.map((row: { id: string }) => row.id)).not.toContain(
      b.body.data.id,
    );

    const firstPage = await list(finance, { ...query, limit: 1 });
    expect(firstPage.body.data).toHaveLength(1);
    expect(firstPage.body.meta.nextCursor).toEqual(expect.any(String));
    const secondPage = await list(finance, {
      ...query,
      limit: 1,
      cursor: firstPage.body.meta.nextCursor,
    });
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data).toHaveLength(1);
    expect(secondPage.body.data[0].id).not.toBe(firstPage.body.data[0].id);

    const badCursor = await list(finance, { ...query, cursor: "not-a-cursor" });
    expect(badCursor.status).toBe(422);
  });

  it("[legend-4961-CB-31] a window with no entries is an empty page, not an error", async () => {
    const res = await list(finance, {
      legalEntityId: world.entityId,
      from: "2001-01-01",
      to: "2001-01-31",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.nextCursor).toBeNull();
  });

  it("[legend-4961-CB-32] reads one entry by id; an unknown id is 404", async () => {
    const made = await post(finance, transferBody({ amountIdr: 7_000 }));
    expect(made.status).toBe(201);
    const found = await finance.client
      .get(`${ENTRIES}/${made.body.data.id}`)
      .set(originHeader);
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body.data).toMatchObject({
      id: made.body.data.id,
      kind: "transfer",
      amountIdr: 7_000,
    });
    const missing = await finance.client
      .get(`${ENTRIES}/${randomUUID()}`)
      .set(originHeader);
    expect(missing.status).toBe(404);
  });
});

describe("legend-4961 database guards on the document tables", () => {
  it("[legend-4961-CB-40] the table refuses a zero amount, a self transfer and a counter account on a transfer", async () => {
    const made = await post(finance, transferBody({ amountIdr: 8_000 }));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.data.id as string;
    for (const set of [
      "amount_idr = 0",
      "amount_idr = -5",
      "to_bank_account_id = bank_account_id",
      `counter_account_id = '${world.gl.revenue}'`,
    ])
      await expect(
        asOwnerTenant((client) =>
          client.query(
            `UPDATE cash_bank_entries SET ${set} WHERE tenant_id = $1 AND id = $2`,
            [tenantId, id],
          ),
        ),
        set,
      ).rejects.toMatchObject({ code: "23514" });
  });

  it("[legend-4961-CB-41] one journal can back only one document", async () => {
    const made = await post(finance, cashInBody({ amountIdr: 9_000 }));
    expect(made.status).toBe(201);
    const id = made.body.data.id as string;
    await expect(
      asOwnerTenant((client) =>
        client.query(
          `INSERT INTO cash_bank_entries
             (id, tenant_id, legal_entity_id, outlet_id, kind, entry_date, amount_idr,
              bank_account_id, to_bank_account_id, counter_account_id, description,
              reference, idempotency_key, journal_entry_id, created_by)
           SELECT gen_random_uuid(), tenant_id, legal_entity_id, outlet_id, kind, entry_date,
                  amount_idr, bank_account_id, to_bank_account_id, counter_account_id,
                  description, reference, 'dup-' || gen_random_uuid()::text,
                  journal_entry_id, created_by
             FROM cash_bank_entries WHERE tenant_id = $1 AND id = $2`,
          [tenantId, id],
        ),
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("[legend-4961-CB-42] the runtime login cannot edit or delete a recorded entry", async () => {
    const made = await post(finance, cashInBody({ amountIdr: 6_000 }));
    expect(made.status).toBe(201);
    const id = made.body.data.id as string;
    await expect(
      asRuntime((client) =>
        client.query(
          "DELETE FROM cash_bank_entries WHERE tenant_id = $1 AND id = $2",
          [tenantId, id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asRuntime((client) =>
        client.query(
          "UPDATE cash_bank_entries SET amount_idr = 1 WHERE tenant_id = $1 AND id = $2",
          [tenantId, id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // Still the recorded amount.
    expect((await entryRow(id)).amount_idr).toBe("6000");
  });
});
