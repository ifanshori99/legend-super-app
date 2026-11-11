// WS-05 / legend-lnit: hardening of the payment admin cashier defaults
// (PRD "Routing kasir", EDC-07, TEN-03). Written from the shared payment
// contract and the role templates, not from the services.
//
// Assumptions (spec is silent):
// - "Cashier of an outlet" = a user with an active role assignment (valid
//   window includes now) whose role grants pos.payment.accept at that outlet
//   (outlet scope for that outlet, or tenant scope). The cashier template
//   grants it; the waiter template does not.
// - A refused default answers a 4xx in {400,403,404,409}; the exact code is
//   not fixed by the spec, so the tests only pin "refused and nothing saved".
// - Deactivating a terminal clears (or hides) the cashier defaults that point
//   at it; the tests accept either as long as no cashier shows that terminal
//   and no row still points at it.
// - Same for a terminal that stops supporting a method: a default whose
//   method the terminal no longer supports (edc_card needs "card") is cleared
//   or hidden; a default whose method is still supported (edc_qris) stays.
// - Replaying a default update with the same Idempotency-Key and the same body
//   returns the stored answer (same status, same body), even when the
//   terminal went inactive in between; it is not a new 4xx.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const outletB = cafeLegendAccessFixtures.outletIds.bandung2;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const REFUSED = [400, 403, 404, 409];
const userIds: string[] = [];
const terminalIds: string[] = [];
let manager: ReturnType<typeof agent>;

async function newUser(label: string) {
  const client = agent(app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  userIds.push(userId);
  await verifySessionMfa(email);
  return { client, userId };
}

async function assign(
  userId: string,
  templateKey: "owner" | "cashier" | "waiter",
  scope: { type: "tenant" } | { type: "outlet"; id: string },
  window: { from?: string; until?: string | null } = {},
) {
  const role = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() + $6::interval, ${
       window.until === undefined ? "NULL" : "now() + $7::interval"
     }, $2)`,
    [
      tenantId,
      userId,
      role.rows[0]!.id,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
      window.from ?? "-1 hour",
      ...(window.until === undefined ? [] : [window.until]),
    ],
  );
}

async function createTerminal(
  bankCode: "bca" | "mandiri" | "bni" | "bjb" = "bca",
) {
  const response = await manager
    .post("/api/payments/admin/edc/terminals")
    .set(originHeader)
    .set("Idempotency-Key", `lnit-${randomUUID()}`)
    .send({
      outletId: outletA,
      bankCode,
      terminalId: `T-${randomUUID()}`,
      merchantId: `MID-${bankCode}`,
      model: "Lnit terminal",
      connection: "usb",
      ipAddress: null,
      supportedMethods: ["card", "qris"],
      status: "active",
    });
  expect(response.status).toBe(201);
  terminalIds.push(response.body.data.id);
  return response.body.data.id as string;
}

const putDefault = (
  client: ReturnType<typeof agent>,
  cashierId: string,
  outletId: string,
  terminalId: string | null,
  defaultMethod = "edc_card",
  idempotencyKey = `lnit-${randomUUID()}`,
) =>
  client
    .put(`/api/payments/admin/edc/cashier-defaults/${cashierId}`)
    .set(originHeader)
    .set("Idempotency-Key", idempotencyKey)
    .send({ outletId, terminalId, defaultMethod });

type DefaultsView = {
  cashiers: { cashierId: string; terminalId: string | null }[];
};
async function readDefaults(outletId = outletA) {
  const response = await manager.get(
    `/api/payments/admin/edc/cashier-defaults?outletId=${outletId}`,
  );
  expect(response.status).toBe(200);
  return response.body.data as DefaultsView;
}
const rowsFor = async (cashierId: string) =>
  (
    await owner.query<{ terminal_id: string | null }>(
      "SELECT terminal_id FROM payment_cashier_defaults WHERE tenant_id = $1 AND cashier_id = $2",
      [tenantId, cashierId],
    )
  ).rows;

beforeAll(async () => {
  const admin = await newUser("Lnit admin");
  manager = admin.client;
  await assign(admin.userId, "owner", { type: "tenant" });
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM payment_cashier_defaults WHERE cashier_id = ANY($1::uuid[]) OR terminal_id = ANY($2::uuid[])",
    [userIds, terminalIds],
  );
  await owner.query(
    "DELETE FROM payment_edc_terminals WHERE id = ANY($1::uuid[])",
    [terminalIds],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
    [userIds],
  );
  await owner.end();
});

describe("WS-05 lnit B1: a deactivated terminal leaves no cashier default", () => {
  it("EDC-07 deactivating a terminal clears the cashier defaults pointing at it", async () => {
    const cashier = await newUser("Lnit cashier b1");
    await assign(cashier.userId, "cashier", { type: "outlet", id: outletA });
    const doomed = await createTerminal("bca");
    const kept = await createTerminal("bni");
    const other = await newUser("Lnit cashier b1 other");
    await assign(other.userId, "cashier", { type: "outlet", id: outletA });

    expect(
      (await putDefault(manager, cashier.userId, outletA, doomed)).status,
    ).toBe(200);
    expect(
      (await putDefault(manager, other.userId, outletA, kept)).status,
    ).toBe(200);

    const off = await manager
      .patch(`/api/payments/admin/edc/terminals/${doomed}`)
      .set(originHeader)
      .set("Idempotency-Key", `lnit-${randomUUID()}`)
      .send({ status: "inactive" });
    expect(off.status).toBe(200);
    expect(off.body.data.status).toBe("inactive");

    // Nothing stored points at the dead terminal (checked before the screen).
    expect(
      (await rowsFor(cashier.userId)).every(
        (row) => row.terminal_id !== doomed,
      ),
    ).toBe(true);
    const view = await readDefaults();
    const mine = view.cashiers.find((c) => c.cashierId === cashier.userId);
    expect(mine?.terminalId ?? null).not.toBe(doomed);
    // Only the deactivated terminal's defaults go; another cashier keeps theirs.
    expect(
      view.cashiers.find((c) => c.cashierId === other.userId)?.terminalId,
    ).toBe(kept);
  });

  it("EDC-07 removing card from a terminal's supported methods clears the edc_card defaults on it but keeps edc_qris ones", async () => {
    const cardCashier = await newUser("Lnit cashier b1 card");
    await assign(cardCashier.userId, "cashier", {
      type: "outlet",
      id: outletA,
    });
    const qrisCashier = await newUser("Lnit cashier b1 qris");
    await assign(qrisCashier.userId, "cashier", {
      type: "outlet",
      id: outletA,
    });
    const terminal = await createTerminal("bjb"); // supports card and qris

    expect(
      (await putDefault(manager, cardCashier.userId, outletA, terminal)).status,
    ).toBe(200);
    expect(
      (
        await putDefault(
          manager,
          qrisCashier.userId,
          outletA,
          terminal,
          "edc_qris",
        )
      ).status,
    ).toBe(200);

    const narrowed = await manager
      .patch(`/api/payments/admin/edc/terminals/${terminal}`)
      .set(originHeader)
      .set("Idempotency-Key", `lnit-${randomUUID()}`)
      .send({ supportedMethods: ["qris"] });
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.data.supportedMethods).toEqual(["qris"]);
    expect(narrowed.body.data.status).toBe("active");

    // The card default can no longer point at this terminal: not stored, not shown.
    expect(
      (await rowsFor(cardCashier.userId)).every(
        (row) => row.terminal_id !== terminal,
      ),
    ).toBe(true);
    const view = await readDefaults();
    expect(
      view.cashiers.find((c) => c.cashierId === cardCashier.userId)
        ?.terminalId ?? null,
    ).not.toBe(terminal);
    // The terminal still takes QRIS, so that cashier keeps it.
    expect(
      view.cashiers.find((c) => c.cashierId === qrisCashier.userId)?.terminalId,
    ).toBe(terminal);
    expect(
      (await rowsFor(qrisCashier.userId)).some(
        (row) => row.terminal_id === terminal,
      ),
    ).toBe(true);
  });

  it("EDC-07 a cashier default cannot be pointed at an inactive terminal", async () => {
    const cashier = await newUser("Lnit cashier b1 inactive");
    await assign(cashier.userId, "cashier", { type: "outlet", id: outletA });
    const terminal = await createTerminal("mandiri");
    const off = await manager
      .patch(`/api/payments/admin/edc/terminals/${terminal}`)
      .set(originHeader)
      .set("Idempotency-Key", `lnit-${randomUUID()}`)
      .send({ status: "inactive" });
    expect(off.status).toBe(200);

    const response = await putDefault(
      manager,
      cashier.userId,
      outletA,
      terminal,
    );
    expect(REFUSED).toContain(response.status);
    expect(
      (await rowsFor(cashier.userId)).every(
        (row) => row.terminal_id !== terminal,
      ),
    ).toBe(true);
  });

  it("EDC-07 replaying a default update with the same key after the terminal went inactive returns the stored answer, not an error", async () => {
    const cashier = await newUser("Lnit cashier b1 replay");
    await assign(cashier.userId, "cashier", { type: "outlet", id: outletA });
    const terminal = await createTerminal("bni");
    const idempotencyKey = `lnit-replay-${randomUUID()}`;

    const first = await putDefault(
      manager,
      cashier.userId,
      outletA,
      terminal,
      "edc_card",
      idempotencyKey,
    );
    expect(first.status).toBe(200);
    expect(first.body.data.terminalId).toBe(terminal);

    const off = await manager
      .patch(`/api/payments/admin/edc/terminals/${terminal}`)
      .set(originHeader)
      .set("Idempotency-Key", `lnit-${randomUUID()}`)
      .send({ status: "inactive" });
    expect(off.status).toBe(200);

    const replay = await putDefault(
      manager,
      cashier.userId,
      outletA,
      terminal,
      "edc_card",
      idempotencyKey,
    );
    // Same key, same body: the saved answer comes back (not 422/404/409).
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    // The replay is not a new write: nothing points at the dead terminal.
    expect(
      (await rowsFor(cashier.userId)).every(
        (row) => row.terminal_id !== terminal,
      ),
    ).toBe(true);
  });
});

describe("WS-05 lnit B2: only cashiers of that outlet have a default", () => {
  it("TEN-03 a cashier with an active assignment at the outlet can be given a default and is listed", async () => {
    const cashier = await newUser("Lnit cashier active");
    await assign(cashier.userId, "cashier", { type: "outlet", id: outletA });
    const terminal = await createTerminal("bca");
    const saved = await putDefault(manager, cashier.userId, outletA, terminal);
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({
      cashierId: cashier.userId,
      terminalId: terminal,
      defaultMethod: "edc_card",
    });
    const view = await readDefaults();
    expect(
      view.cashiers.find((c) => c.cashierId === cashier.userId)?.terminalId,
    ).toBe(terminal);
  });

  it("TEN-03 a user with no role at all cannot be given a default", async () => {
    const stranger = await newUser("Lnit stranger");
    const response = await putDefault(
      manager,
      stranger.userId,
      outletA,
      null,
      "qris_doit",
    );
    expect(REFUSED).toContain(response.status);
    expect(await rowsFor(stranger.userId)).toEqual([]);
  });

  it("TEN-03 a waiter, who cannot take payments, cannot be given a default", async () => {
    const waiter = await newUser("Lnit waiter");
    await assign(waiter.userId, "waiter", { type: "outlet", id: outletA });
    const response = await putDefault(
      manager,
      waiter.userId,
      outletA,
      null,
      "qris_doit",
    );
    expect(REFUSED).toContain(response.status);
    expect(await rowsFor(waiter.userId)).toEqual([]);
  });

  it("TEN-03 a cashier of another outlet cannot be given a default here", async () => {
    const elsewhere = await newUser("Lnit cashier elsewhere");
    await assign(elsewhere.userId, "cashier", { type: "outlet", id: outletB });
    const response = await putDefault(
      manager,
      elsewhere.userId,
      outletA,
      null,
      "qris_doit",
    );
    expect(REFUSED).toContain(response.status);
    expect(await rowsFor(elsewhere.userId)).toEqual([]);
  });

  it("TEN-03 an expired or not-yet-valid cashier assignment gives no default", async () => {
    const expired = await newUser("Lnit cashier expired");
    await assign(
      expired.userId,
      "cashier",
      { type: "outlet", id: outletA },
      {
        from: "-2 hours",
        until: "-1 hour",
      },
    );
    const future = await newUser("Lnit cashier future");
    await assign(
      future.userId,
      "cashier",
      { type: "outlet", id: outletA },
      {
        from: "1 day",
      },
    );
    for (const person of [expired, future]) {
      const response = await putDefault(
        manager,
        person.userId,
        outletA,
        null,
        "qris_doit",
      );
      expect(REFUSED).toContain(response.status);
      expect(await rowsFor(person.userId)).toEqual([]);
    }
  });

  it("TEN-03 the cashier list never shows people who are not cashiers of the outlet", async () => {
    // Stale rows (a role removed, expired or moved outlet) seeded directly.
    const stranger = await newUser("Lnit stale stranger");
    const expired = await newUser("Lnit stale expired");
    await assign(
      expired.userId,
      "cashier",
      { type: "outlet", id: outletA },
      {
        from: "-2 hours",
        until: "-1 hour",
      },
    );
    const elsewhere = await newUser("Lnit stale elsewhere");
    await assign(elsewhere.userId, "cashier", { type: "outlet", id: outletB });
    for (const person of [stranger, expired, elsewhere])
      await owner.query(
        `INSERT INTO payment_cashier_defaults (tenant_id, outlet_id, cashier_id, terminal_id, default_method)
         VALUES ($1, $2, $3, NULL, 'qris_doit')`,
        [tenantId, outletA, person.userId],
      );
    const listed = (await readDefaults()).cashiers.map((c) => c.cashierId);
    for (const person of [stranger, expired, elsewhere])
      expect(listed).not.toContain(person.userId);
  });
});
