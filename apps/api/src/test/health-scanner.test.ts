import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { db } from "../db";
import { createStorageRuntimeFromEnv } from "../services/core-storage-runtime";
import {
  startFakeClamd,
  unusedPort,
  type FakeClamd,
} from "./helpers/fake-clamd";

// legend-w9hwh (M4): GET /api/health -> { status: "ok", scanner } with HTTP 200
// whatever the scanner state. "disabled" when CLAMD_HOST is empty.

const FULL_STORAGE_ENV = {
  STORAGE_S3_ACCESS_KEY_ID: "sentinel-access-key-id",
  STORAGE_S3_SECRET_ACCESS_KEY: "sentinel-secret-access-key",
  STORAGE_S3_PRIVATE_BUCKET: "sentinel-private-bucket",
  STORAGE_S3_PUBLIC_BUCKET: "sentinel-public-bucket",
  STORAGE_PUBLIC_BASE_URL: "https://sentinel.example/images",
};
const servers: FakeClamd[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

// The app gets its scanner through the storage runtime built from env
// (createStorageRuntimeFromEnv -> createApp({ storageRuntime })), the same
// path server.ts uses. Assumption: the app is built that way in production.
function appWith(clamd: Record<string, string>) {
  const runtime = createStorageRuntimeFromEnv(
    { ...FULL_STORAGE_ENV, ...clamd },
    db,
  );
  return createApp({ storageRuntime: runtime });
}

describe("legend-w9hwh GET /api/health scanner field", () => {
  it('reports scanner "disabled" when storage is not configured at all', async () => {
    const response = await request(createApp({ storageRuntime: null })).get(
      "/api/health",
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", scanner: "disabled" });
  });

  it('reports scanner "disabled" when CLAMD_HOST is not set', async () => {
    const app = appWith({});
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", scanner: "disabled" });
  });

  it('reports scanner "disabled" when CLAMD_HOST is empty', async () => {
    const app = appWith({ CLAMD_HOST: "" });
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", scanner: "disabled" });
  });

  it('reports scanner "ok" when clamd answers PONG', async () => {
    const server = await startFakeClamd({ kind: "reply", reply: "PONG\0" });
    servers.push(server);
    const app = appWith({
      CLAMD_HOST: "127.0.0.1",
      CLAMD_PORT: String(server.port),
    });
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", scanner: "ok" });
    expect(server.sessions[0]!.command).toBe("zPING");
  });

  it('reports scanner "unavailable" with HTTP 200 when clamd refuses connections', async () => {
    const app = appWith({
      CLAMD_HOST: "127.0.0.1",
      CLAMD_PORT: String(await unusedPort()),
    });
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", scanner: "unavailable" });
  });

  it('reports scanner "unavailable" with HTTP 200 when clamd does not answer in time', async () => {
    const server = await startFakeClamd({ kind: "silent" });
    servers.push(server);
    const app = appWith({
      CLAMD_HOST: "127.0.0.1",
      CLAMD_PORT: String(server.port),
      CLAMD_TIMEOUT_MS: "1000",
    });
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", scanner: "unavailable" });
  });

  it("caches the scanner state between requests (one PING within 30 s)", async () => {
    const server = await startFakeClamd({ kind: "reply", reply: "PONG\0" });
    servers.push(server);
    const app = appWith({
      CLAMD_HOST: "127.0.0.1",
      CLAMD_PORT: String(server.port),
    });
    await request(app).get("/api/health");
    await request(app).get("/api/health");
    await request(app).get("/api/health");
    expect(
      server.sessions.filter((session) => session.command === "zPING"),
    ).toHaveLength(1);
  });
});
