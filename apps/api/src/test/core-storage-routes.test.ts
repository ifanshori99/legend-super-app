import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
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
import { signedStorageUrl, uploadStorage } from "../services/core-storage";

const context = establishScopedTenantContext(
  establishTenantContext({
    tenantId: cafeLegendFixtures.tenant.id,
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);
const outletId = cafeLegendFixtures.outlets[0]!.id;
const actorUserId = "user-route-actor";
const authorize = vi.fn(async () => true);
function app() {
  const app = express();
  // The route delegates database and provider work to mocked service calls.
  app.use(
    "/api",
    createStorageRouter({
      database: {} as never,
      storage: {} as never,
      scanner: {} as never,
      resolveRequest: async () => ({ context, authorize, actorUserId }),
    }),
  );
  app.use(errorHandler);
  return app;
}
const stored = () => ({
  id: randomUUID(),
  purpose: "receipt" as const,
  contentType: "image/webp",
  sizeBytes: 1,
  width: 1,
  height: 1,
  publicUrl: null,
  thumbnailUrl: null,
});
beforeEach(() => {
  vi.mocked(uploadStorage).mockReset();
  vi.mocked(signedStorageUrl).mockReset();
});
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
  it("legend-pszrm passes the verified actor and named source kind to the service", async () => {
    vi.mocked(uploadStorage).mockResolvedValueOnce(stored());
    const res = await request(app())
      .post("/api/storage/uploads")
      .field("purpose", "receipt")
      .field("outletId", outletId)
      .field("sourceKind", "reimbursement")
      .attach("file", Buffer.from("test"), "x.jpg");
    expect(res.status).toBe(201);
    expect(uploadStorage).toHaveBeenCalledTimes(1);
    const [, , metadata, , deps] = vi.mocked(uploadStorage).mock.calls[0]!;
    expect(metadata).toEqual({
      purpose: "receipt",
      outletId,
      sourceKind: "reimbursement",
    });
    expect(deps).toMatchObject({ actorUserId, authorize });
  });
  it("legend-pszrm still accepts an upload that names no source kind", async () => {
    vi.mocked(uploadStorage).mockResolvedValueOnce(stored());
    const res = await request(app())
      .post("/api/storage/uploads")
      .field("purpose", "receipt")
      .field("outletId", outletId)
      .attach("file", Buffer.from("test"), "x.jpg");
    expect(res.status).toBe(201);
    expect(vi.mocked(uploadStorage).mock.calls[0]![2]).toEqual({
      purpose: "receipt",
      outletId,
    });
  });
  it("legend-pszrm rejects an unknown source kind before calling the service", async () => {
    const res = await request(app())
      .post("/api/storage/uploads")
      .field("purpose", "receipt")
      .field("outletId", outletId)
      .field("sourceKind", "payroll")
      .attach("file", Buffer.from("test"), "x.jpg");
    expect(res.status).toBe(422);
    expect(uploadStorage).not.toHaveBeenCalled();
  });
  it("legend-pszrm rejects a source kind that belongs to another purpose", async () => {
    const res = await request(app())
      .post("/api/storage/uploads")
      .field("purpose", "selfie")
      .field("outletId", outletId)
      .field("sourceKind", "reimbursement")
      .attach("file", Buffer.from("test"), "x.jpg");
    expect(res.status).toBe(422);
    expect(uploadStorage).not.toHaveBeenCalled();
  });
  it("legend-pszrm rejects a client supplied owner", async () => {
    const res = await request(app())
      .post("/api/storage/uploads")
      .field("purpose", "receipt")
      .field("outletId", outletId)
      .field("sourceKind", "reimbursement")
      .field("ownerUserId", "someone-else")
      .attach("file", Buffer.from("test"), "x.jpg");
    expect(res.status).toBe(422);
    expect(uploadStorage).not.toHaveBeenCalled();
  });
  it("legend-pszrm hands the read authorizer to the signed url service", async () => {
    const objectId = randomUUID();
    vi.mocked(signedStorageUrl).mockResolvedValueOnce({
      url: "https://files.example.test/x",
      expiresAt: new Date().toISOString(),
    });
    const res = await request(app())
      .post(`/api/storage/objects/${objectId}/signed-url`)
      .send({ variant: "original" });
    expect(res.status).toBe(200);
    const [, , id, variant, deps] = vi.mocked(signedStorageUrl).mock.calls[0]!;
    expect(id).toBe(objectId);
    expect(variant).toBe("original");
    expect(deps.authorize).toBe(authorize);
  });
});
