// Independent HTTP fixtures for legend-co93l and legend-utnll. Only the
// disposable test database is written; production services are not imported.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { totpCode, totpStep } from "../lib/totp";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";

export const app = createApp();
export const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const platformIds: string[] = [];

export async function signedIn(name: string) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  return { client, email, userId: session.body.user.id as string };
}

export async function platformAdmin(name = "Platform Directory") {
  const user = await signedIn(name);
  await owner.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
    user.userId,
  ]);
  platformIds.push(user.userId);
  await verifySessionMfa(user.email);
  return user;
}

export async function enrollTotp(user: Awaited<ReturnType<typeof signedIn>>) {
  const enrolled = await user.client
    .post("/api/auth/mfa/factors")
    .set(originHeader)
    .send({ type: "totp" });
  expect(enrolled.status).toBe(201);
  const { factorId, secretBase32 } = enrolled.body.data as {
    factorId: string;
    secretBase32: string;
  };
  const verified = await user.client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({ factorId, code: totpCode(secretBase32, totpStep(new Date())) });
  expect(verified.status).toBe(200);
  return async () => {
    await owner.query(
      "UPDATE mfa_factors SET last_used_step = NULL WHERE id = $1",
      [factorId],
    );
    return totpCode(secretBase32, totpStep(new Date()));
  };
}

export async function tenant(label: string) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, $3, plan, 'active', deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $4`,
    [id, `directory-${id}`, label, cafeLegendPlatformFixtures.tenant.id],
  );
  await owner.query(
    `INSERT INTO roles
       (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $2 AND template_key IN ('owner', 'tenant_admin')`,
    [id, cafeLegendPlatformFixtures.tenant.id],
  );
  return id;
}

export async function account(name: string) {
  const id = randomUUID();
  const email = `${id}@directory.example`;
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, name, email],
  );
  return { userId: id, name, email };
}

export async function assign(
  tenantId: string,
  userId: string,
  template = "tenant_admin",
  window: "active" | "expired" | "future" = "active",
) {
  const now = Date.now();
  const from = new Date(now + (window === "future" ? 86_400_000 : -86_400_000));
  const until = window === "expired" ? new Date(now - 60_000) : null;
  const result = await owner.query<{ id: string }>(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, valid_until, assigned_by)
     SELECT $1, $2, id, 'tenant', $4, $5, $2 FROM roles
       WHERE tenant_id = $1 AND template_key = $3 RETURNING id`,
    [tenantId, userId, template, from, until],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!.id;
}

export async function supportReadOnly(tenantId: string, userId: string) {
  const now = new Date(Date.now() - 1_000);
  await owner.query(
    `INSERT INTO support_access_grants
       (tenant_id, super_admin_user_id, reason, access_mode, duration_minutes,
        started_at, expires_at, mfa_verified_at)
     VALUES ($1, $2, 'Memeriksa dukungan tenant tanpa hak mengubah Owner.', 'read_only',
             60, $3, $4, $3)`,
    [tenantId, userId, now, new Date(now.getTime() + 3_600_000)],
  );
}

export async function audit(tenantId: string, actorId: string, action: string) {
  const result = await owner.query<{ event: Record<string, unknown> }>(
    `SELECT event FROM audit_logs WHERE tenant_id = $1
       AND event->>'actorId' = $2 AND event->>'action' = $3 ORDER BY id`,
    [tenantId, actorId, action],
  );
  return result.rows.map((row) => row.event);
}

export async function closeFixtures() {
  if (platformIds.length)
    await owner.query(
      "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
      [platformIds],
    );
  await owner.end();
}
