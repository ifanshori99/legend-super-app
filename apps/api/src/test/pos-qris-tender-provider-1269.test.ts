// 1269 C0 (legend-osqou.1): a cashier QRIS tender records the provider that
// issued its intent, never a fixed `doit`.
import { afterAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { owner } from "./floor-test-helpers.ts";
import {
  holdFixture,
  issueQris,
  newSubmittedOrder,
  payNotice,
  resetHoldPorts,
} from "./pos-qris-hold-test-helpers.ts";

afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

describe("POS QRIS tender provider", () => {
  it.each(["duitku", "doit"])(
    "is the intent's provider (%s), also once paid",
    async (provider) => {
      const fx = await holdFixture(`tender-${provider}`, { provider });
      const order = await newSubmittedOrder(fx);
      const qr = await issueQris(fx, order.id);
      expect(qr.provider).toBe(provider);
      expect(qr.response.body.data.tender.provider).toBe(provider);
      await payNotice(fx, qr.intentId, qr.amountIdr);
      const { rows } = await owner.query<{
        provider: string;
        status: string;
        amount_idr: string;
      }>(
        `SELECT provider, status, amount_idr FROM pos_order_tenders
          WHERE tenant_id=$1 AND order_id=$2`,
        [fx.tenant.tenantId, ulidToUuid(order.id)],
      );
      expect(
        rows.map((row) => ({ ...row, amount_idr: Number(row.amount_idr) })),
      ).toEqual([{ provider, status: "captured", amount_idr: order.totalIdr }]);
    },
  );
});
