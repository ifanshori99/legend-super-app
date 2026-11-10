// Founder decision Q69 (10 Nov 2026): the built-in daily point cap per customer
// is 500 points, not 1.000. Both the contract default (a program read without
// `antiFraud`) and the column default (a program row inserted without the cap)
// must say 500. The earn and point values (Rp10.000 = 1 point, 1 point =
// Rp100) are unchanged.

import { afterAll, describe, expect, it } from "vitest";
import {
  defaultLoyaltyAntiFraud,
  loyaltyProgramSchema,
} from "@starter/shared/crm";
import { asTenant, createWorld, owner } from "./member-loyalty-helpers";

afterAll(async () => {
  await owner.end();
});

describe("legend-m4p5 Q69 daily point cap default", () => {
  it("[Q69-1] the contract default is 500 points per customer per day", () => {
    expect(defaultLoyaltyAntiFraud.dailyPointCapPerCustomer).toBe(500);
    expect(
      loyaltyProgramSchema.shape.antiFraud.parse(undefined)
        .dailyPointCapPerCustomer,
    ).toBe(500);
  });

  it("[Q69-2] a program row inserted without a cap gets 500; earn and point values stay", async () => {
    const world = await createWorld();
    const row = await asTenant(world.tenantId, async (client) => {
      const result = await client.query<{
        daily_point_cap_per_customer: string;
        earn_spend_idr: string;
        earn_points: number;
        point_value_idr: string;
      }>(
        `INSERT INTO loyalty_programs (tenant_id) VALUES ($1)
         RETURNING daily_point_cap_per_customer, earn_spend_idr, earn_points, point_value_idr`,
        [world.tenantId],
      );
      return result.rows[0];
    });
    expect(Number(row?.daily_point_cap_per_customer)).toBe(500);
    expect(Number(row?.earn_spend_idr)).toBe(10_000);
    expect(row?.earn_points).toBe(1);
    expect(Number(row?.point_value_idr)).toBe(100);
  });
});
