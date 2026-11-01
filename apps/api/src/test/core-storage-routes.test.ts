import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendFixtures } from "@starter/shared/core";

vi.mock("../middleware/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../middleware/origin", () => ({
  requireTrustedOrigin: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
vi.mock("../services/core-storage", () => ({
  uploadStorage: vi.fn(),
  signedStorageUrl: vi.fn(),
}));
import { createStorageRouter } from "../routes/core-storage.routes";
import { errorHandler } from "../middleware/error-handler";
import { uploadStorage } from "../services/core-storage";

const context = establishScopedTenantContext(
  establishTenantContext({
    tenantId: cafeLegendFixtures.tenant.id,
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);
const outletId = cafeLegendFixtures.outlets[0]!.id;
function app() {
  const app = express();
  // The route delegates database and provider work to mocked service calls.
  app.use(
    "/api",
    createStorageRouter({
      database: {} as never,
      storage: {} as never,
      scanner: {} as never,
      resolveRequest: async () => ({ context, authorize: async () => true }),
    }),
  );
  app.use(errorHandler);
  return app;
}
describe("legend-ruf storage routes", () => {
  it("rejects client supplied tenant identity", async () => {
    const res = await request(app())
      .post("/api/storage/uploads")
      .field("purpose", "selfie")
      .field("outletId", outletId)
      .field("tenantId", cafeLegendFixtures.tenant.id)
      .attach("file", Buffer.from("test"), "x.jpg");
    expect(res.status).toBe(422);
    expect(uploadStorage).not.toHaveBeenCalled();
  });
  it("rejects uploads over ten MiB before calling the service", async () => {
    const res = await request(app())
      .post("/api/storage/uploads")
      .field("purpose", "selfie")
      .field("outletId", outletId)
      .attach("file", Buffer.alloc(10 * 1024 * 1024 + 1), "x.jpg");
    expect(res.status).toBe(413);
    expect(uploadStorage).not.toHaveBeenCalled();
  });
});
