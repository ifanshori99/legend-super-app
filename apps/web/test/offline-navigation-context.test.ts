import { describe, expect, it } from "vitest";
import { loadWithOfflineFallback } from "@/lib/offline-navigation";

// O5 release bug (27 Nov): on the offline tablet every in-app navigation (phone
// "Lihat keranjang", "Tutup shift") ran the root beforeLoad, whose server
// calls need the internet, and landed on "Terjadi kesalahan". While the
// network is gone the last context the browser resolved stays in force; the
// API still authenticates every request on its own.

describe("loadWithOfflineFallback", () => {
  it("returns the fresh value while online", async () => {
    const out = await loadWithOfflineFallback(async () => "fresh", "old", {
      offline: () => false,
    });
    expect(out).toBe("fresh");
  });

  it("keeps the last value when the network is gone", async () => {
    const out = await loadWithOfflineFallback(
      async () => {
        throw new TypeError("Failed to fetch");
      },
      "old",
      { offline: () => true },
    );
    expect(out).toBe("old");
  });

  it("keeps the last value on a fetch TypeError even if the browser says online", async () => {
    const out = await loadWithOfflineFallback(
      async () => {
        throw new TypeError("Failed to fetch");
      },
      "old",
      { offline: () => false },
    );
    expect(out).toBe("old");
  });

  it("rethrows when there is no earlier value", async () => {
    await expect(
      loadWithOfflineFallback(
        async () => {
          throw new TypeError("Failed to fetch");
        },
        null,
        { offline: () => true },
      ),
    ).rejects.toThrow("Failed to fetch");
  });

  it("rethrows a real server error while online", async () => {
    await expect(
      loadWithOfflineFallback(
        async () => {
          throw new Error("boom");
        },
        "old",
        { offline: () => false },
      ),
    ).rejects.toThrow("boom");
  });
});
