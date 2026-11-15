// Menu import/print router wired to the storage runtime (bead legend-0w2wy):
// createApp({ storageRuntime }) hands createMenuImportRouter the storage and
// scanner, and the print path refuses a scanner that cannot vet documents (the
// production noop) BEFORE rendering or storing anything.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { printableMenuRenders } from "../db/schema/menu-import.ts";
import { withTenant } from "../db/tenant.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { validPdfBytes } from "./helpers/pdf-fixtures.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import {
  regenerateMenuPrint,
  type MenuPdfRenderer,
} from "../services/menu-print.service.ts";
import { staffWithRole, type Staff } from "./floor-test-helpers.ts";

const { tenant, outlets } = cafeLegendFixtures;
const outletA = outlets[0].id;

class CountingStorage extends FakeObjectStorage {
  puts = 0;
  override async put(...args: Parameters<FakeObjectStorage["put"]>) {
    this.puts += 1;
    return super.put(...args);
  }
}
class CountingRenderer implements MenuPdfRenderer {
  calls = 0;
  async render() {
    this.calls += 1;
    // A real PDF: storage parses document uploads (legend-851ef).
    return validPdfBytes();
  }
}

const ctx = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.id,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

const runtime: StorageRuntime = {
  storage: new CountingStorage(),
  scanner: new NoopMalwareScanner(),
  fileSigner: async () => "https://signed.example.test/x",
  hrisDocumentSigner: async () => null,
};
const appWithStorage = createApp({ storageRuntime: runtime });
const appWithoutStorage = createApp({ storageRuntime: null });

let withStaff: Staff;
let withoutStaff: Staff;
beforeAll(async () => {
  withStaff = await staffWithRole(appWithStorage, {
    template: "owner",
    tenantId: tenant.id,
  });
  withoutStaff = await staffWithRole(appWithoutStorage, {
    template: "owner",
    tenantId: tenant.id,
  });
});
afterAll(() => undefined);

describe("menu import router in createApp", () => {
  it("with a storage runtime the print route has a default PDF renderer (no 503 for renderer or storage)", async () => {
    const res = await withStaff.client.get(
      `/api/menu/print?outletId=${outletA}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("Pembuat PDF");
  });

  it("without a storage runtime the print route answers the storage 503", async () => {
    const res = await withoutStaff.client.get(
      `/api/menu/print?outletId=${outletA}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(res.body.error.message).toContain("Penyimpanan");
  });

  it("import validate still works (mounted once, auth guarded)", async () => {
    const res = await withStaff.client
      .post("/api/menu/import/validate")
      .send({});
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(503);
    const anon = await (
      await import("./helpers.ts")
    )
      .agent(appWithStorage)
      .post("/api/menu/import/validate")
      .send({});
    expect(anon.status).toBe(401);
  });
});

describe("menu print with a scanner that refuses documents", () => {
  it("503 before the renderer runs and before any blob is stored; accepting scanner renders", async () => {
    const storage = new CountingStorage();
    const renderer = new CountingRenderer();
    await expect(
      regenerateMenuPrint(ctx(), outletA, {
        storage,
        renderer,
        scanner: new NoopMalwareScanner({ acceptsDocuments: false }),
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("pemindai malware"),
    });
    expect(renderer.calls).toBe(0);
    expect(storage.puts).toBe(0);

    // An earlier test in this file already stored a render of the same menu
    // (GET /api/menu/print); with the same content hash the next run would be
    // reused and never call the renderer. Forget the stored hash first.
    await withTenant(db, ctx(), (tx) =>
      tx
        .update(printableMenuRenders)
        .set({ contentHash: null })
        .where(eq(printableMenuRenders.outletId, outletA)),
    );
    await regenerateMenuPrint(ctx(), outletA, {
      storage,
      renderer,
      scanner: new NoopMalwareScanner(),
    });
    expect(renderer.calls).toBe(1);
    expect(storage.puts).toBeGreaterThan(0);
  });
});
