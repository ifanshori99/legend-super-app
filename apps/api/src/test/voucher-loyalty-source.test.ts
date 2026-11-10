// legend-xzr10: staff voucher issue must refuse source 'loyalty_reward' (only the
// reward redemption and mission services mint those), and the two new CRM error
// codes must be present in the shared status and message maps.
import { afterAll, describe, expect, it } from "vitest";
import {
  CRM_ERROR_CODES,
  crmErrorHttpStatus,
  crmErrorMessages,
} from "@starter/shared/crm";
import { createApp } from "../app";
import { originHeader } from "./helpers";
import { owner, seededTenantId, staffWithRole } from "./floor-test-helpers";

const app = createApp();
const startsAt = () => new Date(Date.now() - 3_600_000).toISOString();

afterAll(async () => {
  await owner.end();
});

function body(source: string) {
  return {
    promotionId: null,
    customerProfileId: null,
    source,
    valueIdr: 1000,
    validFrom: startsAt(),
    validUntil: null,
  };
}

describe("legend-xzr10 staff voucher source", () => {
  it("refuses source loyalty_reward with 422 and stores no voucher", async () => {
    const staff = await staffWithRole(app, {
      template: "owner",
      label: "Voucher Owner",
    });
    const before = await owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM vouchers WHERE tenant_id = $1 AND source = 'loyalty_reward'",
      [seededTenantId],
    );

    const response = await staff.client
      .post("/api/vouchers")
      .set(originHeader)
      .send(body("loyalty_reward"));

    expect(response.status, JSON.stringify(response.body)).toBe(422);
    const after = await owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM vouchers WHERE tenant_id = $1 AND source = 'loyalty_reward'",
      [seededTenantId],
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it("still issues a voucher for a normal source", async () => {
    const staff = await staffWithRole(app, {
      template: "owner",
      label: "Voucher Owner",
    });

    const response = await staff.client
      .post("/api/vouchers")
      .set(originHeader)
      .send(body("manual"));

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.voucher.source).toBe("manual");
  });
});

describe("legend-xzr10 shared error codes", () => {
  it("carries REWARD_HAS_PENDING_REDEMPTIONS (409) and REDEMPTION_CODE_UNAVAILABLE (503) with Indonesian messages", () => {
    expect(CRM_ERROR_CODES).toContain("REWARD_HAS_PENDING_REDEMPTIONS");
    expect(CRM_ERROR_CODES).toContain("REDEMPTION_CODE_UNAVAILABLE");
    expect(crmErrorHttpStatus.REWARD_HAS_PENDING_REDEMPTIONS).toBe(409);
    expect(crmErrorHttpStatus.REDEMPTION_CODE_UNAVAILABLE).toBe(503);
    expect(crmErrorMessages.REWARD_HAS_PENDING_REDEMPTIONS).toBeTruthy();
    expect(crmErrorMessages.REDEMPTION_CODE_UNAVAILABLE).toBeTruthy();
  });
});
