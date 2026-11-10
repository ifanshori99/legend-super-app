// WS-03 menu media body limit (legend-ogzf). The menu photo upload carries a
// base64 JPEG, so POST /api/menu/media gets a 1 MiB JSON parser while every
// other API route keeps the 100 kB cap. Runs the real Express app, Better Auth
// and PostgreSQL. No storage provider is injected by the default app, so a body
// that passes the size gate ends at 503 (fail closed), never 413.
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import { createApp } from "../app";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const tenantId = cafeLegendFixtures.tenant.id;
const ownerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});

afterAll(async () => {
  await ownerPool.end();
});

/** Signed-in tenant owner, who holds menu.item.manage. */
async function ownerClient() {
  const client = agent(app);
  await signUp(client, "Menu Media User");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await ownerPool.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', NULL, now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenantId, userId],
  );
  return client;
}

/** Upload body whose serialized JSON is about `targetBytes` long. */
function uploadBody(targetBytes: number) {
  const overhead = JSON.stringify({
    fileName: "foto.jpg",
    contentType: "image/jpeg",
    dataBase64: "",
    width: 8,
    height: 8,
  }).length;
  return {
    fileName: "foto.jpg",
    contentType: "image/jpeg",
    dataBase64: "A".repeat(targetBytes - overhead),
    width: 8,
    height: 8,
  };
}

describe("legend-ogzf menu media body limit", () => {
  it("accepts a ~700 kB base64 upload body (not 413)", async () => {
    const client = await ownerClient();
    const payload = uploadBody(700_000);
    expect(JSON.stringify(payload).length).toBeGreaterThan(600_000);
    const response = await client
      .post("/api/menu/media")
      .set(originHeader)
      .send(payload);
    expect(response.status).not.toBe(413);
    // Passed the size gate and the schema; no storage is wired, so it fails closed.
    expect(response.status).toBe(503);
  });

  it("refuses an upload body over 1 MiB with 413", async () => {
    const client = await ownerClient();
    const response = await client
      .post("/api/menu/media")
      .set(originHeader)
      .send(uploadBody(1024 * 1024 + 10_000));
    expect(response.status).toBe(413);
    expect(response.body.error?.code ?? response.body.code).toBe(
      "PAYLOAD_TOO_LARGE",
    );
  });

  it("keeps other routes capped at 100 kB", async () => {
    const client = await ownerClient();
    const big = await client
      .post("/api/menu/categories")
      .set(originHeader)
      .send({ name: "x".repeat(150 * 1024) });
    expect(big.status).toBe(413);
    // Under the cap the body is read and rejected by validation, not by size.
    const small = await client
      .post("/api/menu/categories")
      .set(originHeader)
      .send({ name: "x".repeat(50 * 1024) });
    expect(small.status).not.toBe(413);
  });
});
