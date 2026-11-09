// Service-level guard for the brand website staff content (WS-08 S1): only a
// tenant-wide scope may read or save it, an outlet scope gets AccessError
// before any database access. See assertTenantWide in
// services/public-site.service.ts.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AccessError } from "@starter/shared/access";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletIdSchema } from "@starter/shared/core";
import {
  getBrandWebsiteContent,
  saveBrandWebsiteContent,
} from "../services/public-site.service";

const tenantId = randomUUID();
const brandId = randomUUID();
const outletScoped = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "outlets", outletIds: [outletIdSchema.parse(randomUUID())] },
);

describe("brand website service: outlet scope", () => {
  it("TEN-03 getBrandWebsiteContent rejects an outlet scope with AccessError", async () => {
    await expect(
      getBrandWebsiteContent(outletScoped, brandId),
    ).rejects.toBeInstanceOf(AccessError);
  });

  it("TEN-03 saveBrandWebsiteContent rejects an outlet scope with AccessError", async () => {
    await expect(
      saveBrandWebsiteContent(outletScoped, randomUUID(), brandId, {
        content: {},
        publish: false,
      } as never),
    ).rejects.toBeInstanceOf(AccessError);
  });
});
