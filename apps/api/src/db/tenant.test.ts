import { describe, expect, it, vi } from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import { withTenant } from "./tenant";

describe("tenant transaction trust boundary", () => {
  it("rejects forged scoped context before opening a transaction (TEN-02)", async () => {
    const transaction = vi.fn();
    const forged = {
      tenant: { tenantId: "a" },
      outletScope: { kind: "tenant", tenantId: "a" },
    } as unknown as ScopedTenantContext;
    await expect(
      withTenant({ transaction } as never, forged, async () => undefined),
    ).rejects.toThrow("Untrusted tenant context");
    expect(transaction).not.toHaveBeenCalled();
  });
});
