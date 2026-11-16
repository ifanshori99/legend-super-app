// legend-yhia9 C1 review follow-ups: the guards that answer 409 where a path
// used to fall through to the database (or to nothing), and the trigger error
// mapping. Small on purpose; the main acceptance files are pos-qris-hold*.test.ts.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { requestContext } from "../lib/request-context.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { owner } from "./floor-test-helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
import {
  issueQris,
  newSubmittedOrder,
  rawWrite,
  readHolds,
  resetHoldPorts,
  holdFixture,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-review2");
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

const holdActive = (res: { status: number; body: unknown }) => {
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  expect(JSON.stringify(res.body)).toContain("QRIS_HOLD_ACTIVE");
};

describe("trigger error mapping", () => {
  it("answers 409 QRIS_HOLD_ACTIVE, not 500, for a 0369 trigger refusal (also when wrapped)", async () => {
    const trigger = Object.assign(
      new Error("QRIS_HOLD_ACTIVE: order x has a QRIS that can still be paid"),
      { code: "23514" },
    );
    for (const thrown of [
      trigger,
      new Error("Failed query", { cause: trigger }),
    ]) {
      const app = express();
      app.use(requestContext);
      app.get("/", () => {
        throw thrown;
      });
      app.use(errorHandler);
      holdActive(await request(app).get("/"));
    }
  });

  it("keeps a plain check violation a 500 (only the QRIS_HOLD_ACTIVE prefix is mapped)", async () => {
    const other = Object.assign(new Error("QRIS_HOLD_IMMUTABLE: nope"), {
      code: "23514",
    });
    const app = express();
    app.use(requestContext);
    app.get("/", () => {
      throw other;
    });
    app.use(errorHandler);
    expect((await request(app).get("/")).status).toBe(500);
  });
});

describe("guards beyond the tender route", () => {
  it("submit on a bill with a collectible QR is 409 QRIS_HOLD_ACTIVE (DP cannot be attached)", async () => {
    const order = await newSubmittedOrder(fx, 0);
    await issueQris(fx, order.id);
    const current = await fx.get(`${fx.base}/${order.id}`);
    const res = await fx.post(`${fx.base}/${order.id}/submit`, {
      expectedStatus: current.body.data.status,
      idempotencyKey: randomUUID(),
    });
    holdActive(res);
    const bill = await owner.query(
      `SELECT deposit_applied_idr::int AS dp FROM orders
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, ulidToUuid(order.id)],
    );
    expect(bill.rows[0].dp).toBe(0);
  });

  it("a tender cannot be moved to another bill while its QR hold is active (trigger)", async () => {
    const frozen = await newSubmittedOrder(fx, 0);
    const other = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, frozen.id);
    const write = await rawWrite(
      fx,
      "UPDATE pos_order_tenders SET order_id=$3 WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, qr.tenderId, ulidToUuid(other.id)],
    );
    expect(write.ok).toBe(false);
    if (write.ok === false) expect(write.message).toContain("QRIS_HOLD_ACTIVE");
  });

  it("a split cannot be re-made while a part's QR is collectible (SPLIT_LOCKED)", async () => {
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const makeSplit = () =>
      fx.guestPost(guest, "/splits", {
        method: "equal",
        parts: 2,
        idempotencyKey: randomUUID(),
      });
    const split = await makeSplit();
    expect(split.status, JSON.stringify(split.body)).toBe(201);
    const parts = split.body.data.splits as { id: string }[];
    const paid = await fx.guestPost(guest, "/payments", {
      target: { kind: "split", billSplitId: parts[0]!.id },
      method: "qris",
      payerSecret: secretFor(parts[0]!.id),
      idempotencyKey: randomUUID(),
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(
      (await readHolds(fx, order.id)).filter((h) => h.state === "open").length,
    ).toBe(1);

    const again = await makeSplit();
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(JSON.stringify(again.body)).toContain("SPLIT_LOCKED");
  });
});
