import { describe, expect, it } from "vitest";
import {
  forgetRootContext,
  loadWithOfflineFallback,
  recallRootContext,
  rememberRootContext,
} from "@/lib/offline-navigation";

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

describe("review K O5 P3 1: only a lost connection counts as offline", () => {
  it("rethrows a programming TypeError while the browser is online", async () => {
    await expect(
      loadWithOfflineFallback(
        async () => {
          throw new TypeError("Cannot read properties of undefined");
        },
        "old",
        { offline: () => false },
      ),
    ).rejects.toThrow("Cannot read properties");
  });

  it("keeps the last value for the browsers' fetch failure messages", async () => {
    for (const message of [
      "Failed to fetch",
      "Load failed",
      "NetworkError when attempting to fetch resource.",
    ])
      expect(
        await loadWithOfflineFallback(
          async () => {
            throw new TypeError(message);
          },
          "old",
          { offline: () => false },
        ),
      ).toBe("old");
  });
});

describe("review K O5 P2: sign-out forgets the last root context", () => {
  it("after forgetRootContext a lost network no longer shows the old account", async () => {
    rememberRootContext({ session: { user: { id: "account-a" } } });
    expect(recallRootContext()).not.toBeNull();
    forgetRootContext();
    expect(recallRootContext()).toBeNull();
    await expect(
      loadWithOfflineFallback(
        async () => {
          throw new TypeError("Failed to fetch");
        },
        recallRootContext(),
        { offline: () => true },
      ),
    ).rejects.toThrow("Failed to fetch");
  });
});
