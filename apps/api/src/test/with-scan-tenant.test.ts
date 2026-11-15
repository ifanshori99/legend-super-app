import { describe, expect, it, vi } from "vitest";
import { withScanTenant, type MalwareScanner } from "../services/core-image";

describe("withScanTenant (legend-1rtm1)", () => {
  it("adds the tenant key to every scan and keeps the scanner flags", async () => {
    const scan = vi.fn<MalwareScanner["scan"]>().mockResolvedValue(undefined);
    const base: MalwareScanner = {
      scan,
      acceptsDocuments: true,
      failOpenForImages: true,
    };
    const scoped = withScanTenant(base, "tenant-a");
    const bytes = new Uint8Array([1, 2, 3]);

    await scoped.scan(bytes);

    expect(scan).toHaveBeenCalledWith(bytes, { tenantKey: "tenant-a" });
    expect(scoped.acceptsDocuments).toBe(true);
    expect(scoped.failOpenForImages).toBe(true);
  });

  it("keeps an explicit tenant key and propagates errors", async () => {
    const failure = new Error("boom");
    const scan = vi.fn<MalwareScanner["scan"]>().mockRejectedValue(failure);
    const scoped = withScanTenant({ scan }, "tenant-a");

    await expect(
      scoped.scan(new Uint8Array(1), { tenantKey: "tenant-b" }),
    ).rejects.toBe(failure);
    expect(scan).toHaveBeenCalledWith(expect.any(Uint8Array), {
      tenantKey: "tenant-b",
    });
  });
});
