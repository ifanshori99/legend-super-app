// Menu media wiring in the app (bead legend-7nv1): createApp({ storageRuntime })
// hands the menu router its object storage and scanner, so POST /api/menu/media
// stores the photo; with `storageRuntime: null` it still answers 503 and the
// other menu routes stay live. Runs the real Express app, Better Auth, RBAC and
// PostgreSQL against the seeded Cafe Legend tenant; storage is the in-memory fake.
import { Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantId = cafeLegendFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const withStorage: StorageRuntime = {
  storage: new FakeObjectStorage(),
  scanner: new NoopMalwareScanner(),
  fileSigner: async (_context, objectId) =>
    `https://signed.invalid/${objectId}`,
  hrisDocumentSigner: async () => null,
};
const appWithStorage = createApp({ storageRuntime: withStorage });
const appWithoutStorage = createApp({ storageRuntime: null });

const createdUserIds: string[] = [];

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  if (createdUserIds.length > 0)
    await owner.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [createdUserIds],
    );
  await owner.end();
});

async function ownerClient(app: ReturnType<typeof createApp>) {
  const client = agent(app);
  await signUp(client, "Menu Storage User");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', NULL, now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenantId, userId],
  );
  return client;
}

async function photoBody() {
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  return {
    fileName: "foto.png",
    contentType: "image/png",
    dataBase64: png.toString("base64"),
    width: 8,
    height: 8,
  };
}

describe("menu media through createApp storageRuntime", () => {
  it("stores a menu photo and returns a media URL when a runtime is wired", async () => {
    const client = await ownerClient(appWithStorage);
    const res = await client
      .post("/api/menu/media")
      .set(originHeader)
      .send(await photoBody());
    expect(res.status).toBe(201);
    expect(res.body.data.mediaId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.data.mediaUrl).toBeTruthy();
    // Other menu routes stay live.
    const categories = await client.get("/api/menu/categories");
    expect(categories.status).toBe(200);
  });

  it("answers 503 on media upload without a runtime, other menu routes live", async () => {
    const client = await ownerClient(appWithoutStorage);
    const res = await client
      .post("/api/menu/media")
      .set(originHeader)
      .send(await photoBody());
    expect(res.status).toBe(503);
    const categories = await client.get("/api/menu/categories");
    expect(categories.status).toBe(200);
  });

  it("keeps the auth guard on /api/menu without a session", async () => {
    expect(
      (await agent(appWithStorage).get("/api/menu/categories")).status,
    ).toBe(401);
  });
});
