// Shared fixtures for the legend-ts50 Customer 360 and segment tests
// (crm-customer360.test.ts, crm-segments.test.ts). Not a test file.
//
// Each test file works in its own freshly created tenant (createWorld) that has
// a verified hostname, so staff HTTP calls resolve to it and counts such as a
// segment size are deterministic. Seeding is raw SQL as the migration owner
// inside a tenant-GUC transaction; the code under test runs as legend_app.
//
// Assumptions shared by both files:
// - Full WhatsApp numbers are stored sealed in user_identities.value_encrypted
//   with the AAD built by `identityAad` below (the contract does not name it).
// - A staff role with exactly the listed permissions is enough to call the
//   route (no session MFA is required for crm.* permissions).

import { randomBytes, randomUUID } from "node:crypto";
import type { Express } from "express";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { sealSecret } from "../lib/secrets.ts";
import { agent, setRole, signUp } from "./helpers";
import {
  asTenant,
  createWorld,
  hex64,
  owner,
  seedOrder,
  short,
  type World,
} from "./member-loyalty-helpers.ts";

export type CrmWorld = World & { hostname: string; host: { Host: string } };

/** A tenant with two outlets, one brand and a verified hostname. */
export async function createCrmWorld(): Promise<CrmWorld> {
  const world = await createWorld();
  const hostname = `ts50-${short()}.legend.test`;
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'platform_subdomain', 'active', now())`,
    [randomUUID(), world.tenantId, world.brandId, hostname],
  );
  return { ...world, hostname, host: { Host: hostname } };
}

export type CrmStaff = {
  client: ReturnType<typeof agent>;
  userId: string;
  email: string;
};

/** A real account holding a custom tenant-scope role with exactly `permissions`. */
export async function staffWith(
  app: Express,
  world: CrmWorld,
  permissions: string[],
  label = "Staf CRM",
): Promise<CrmStaff> {
  const client = agent(app);
  const email = await signUp(client, label);
  await setRole(email, null);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
    [roleId, world.tenantId, `Peran ${short()}`, JSON.stringify(permissions)],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [world.tenantId, userId, roleId],
  );
  return { client, userId, email };
}

/** A real Better Auth account (the user id satisfies user_identities' FK). */
export async function realUserId(app: Express): Promise<string> {
  const client = agent(app);
  await signUp(client, `Member ${short()}`);
  const session = await client.get("/api/auth/get-session");
  return session.body.user.id as string;
}

// ASSUMPTION: the service opens value_encrypted with the AAD
// `user_identities:<identity id>`. If the implementation binds the envelope to
// something else, change this one function.
export const identityAad = (identityId: string) =>
  `user_identities:${identityId}`;

export type SeededNumber = {
  /** Digits only, e.g. 6281234567890. */
  digits: string;
  /** Digits after the country code, e.g. 81234567890. */
  tail: string;
  last4: string;
  hash: string;
};

/** A random Indonesian mobile number: 62 8xx + 8 digits. */
export function newNumber(): SeededNumber {
  const rest = Array.from(randomBytes(8), (b) => b % 10).join("");
  const digits = `62812${rest}`;
  return {
    digits,
    tail: digits.slice(2),
    last4: digits.slice(-4),
    hash: hex64(),
  };
}

/** Stores the verified WhatsApp identity of `userId` with a sealed full number. */
export async function seedWhatsappIdentity(
  userId: string,
  number: SeededNumber,
): Promise<void> {
  const id = randomUUID();
  const sealed = sealSecret(`+${number.digits}`, identityAad(id));
  await owner.query(
    `INSERT INTO user_identities (id, user_id, type, value_hash, value_encrypted, verified_at)
     VALUES ($1, $2, 'whatsapp', $3, $4, now())`,
    [id, userId, number.hash, sealed],
  );
}

/** Every string value inside a JSON body, so tests are blind to the field name. */
export function jsonStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number") out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) jsonStrings(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) jsonStrings(v, out);
  return out;
}

/** True when any string of the body carries `digits` (ignores spaces, dashes, +). */
export function bodyHasDigits(body: unknown, digits: string): boolean {
  return jsonStrings(body).some((s) => s.replace(/\D/g, "").includes(digits));
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
const dateOf = (at: Date) => at.toISOString().slice(0, 10);

/**
 * One paid order of the profile plus its customer_visits row; keeps the profile's
 * visit counters in step (the earn consumer does this in production).
 */
export async function seedVisit(
  world: CrmWorld,
  profileId: string,
  input: { daysAgo: number; spendIdr: number; outletId?: string },
): Promise<string> {
  const at = daysAgo(input.daysAgo);
  const outletId = input.outletId ?? world.outletA;
  const orderUlid = await seedOrder(world.tenantId, {
    outletId,
    profileId,
    grossSalesIdr: input.spendIdr,
    businessDate: dateOf(at),
  });
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      `INSERT INTO customer_visits
         (tenant_id, outlet_id, customer_profile_id, order_id, business_date, visited_at, spend_idr, item_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
      [
        world.tenantId,
        outletId,
        profileId,
        ulidToUuid(orderUlid),
        dateOf(at),
        at.toISOString(),
        input.spendIdr,
      ],
    );
    await client.query(
      `UPDATE customer_profiles
          SET visits_count = visits_count + 1,
              lifetime_spend_idr = lifetime_spend_idr + $3,
              first_visit_at = LEAST(COALESCE(first_visit_at, $4), $4),
              last_visit_at = GREATEST(COALESCE(last_visit_at, $4), $4)
        WHERE tenant_id = $1 AND id = $2`,
      [world.tenantId, profileId, input.spendIdr, at.toISOString()],
    );
  });
  return orderUlid;
}

/** A menu item in the world's brand. */
export async function seedItem(world: CrmWorld, name: string): Promise<string> {
  const categoryId = randomUUID();
  const itemId = randomUUID();
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      "INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Favorit')",
      [categoryId, world.tenantId, world.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, $5, true, $6)`,
      [itemId, world.tenantId, world.brandId, categoryId, name, randomUUID()],
    );
  });
  return itemId;
}

/** Adds a line of `quantity` x `menuItemId` to an existing paid order. */
export async function seedOrderLine(
  world: CrmWorld,
  orderUlid: string,
  menuItemId: string,
  name: string,
  quantity: number,
  outletId = world.outletA,
): Promise<void> {
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO order_items
         (id, tenant_id, outlet_id, order_id, menu_item_id, name, quantity, unit_price_idr,
          modifiers_total_idr, line_total_idr, modifiers, fire_status, status, reserved_business_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 20000, 0, $8, '[]'::jsonb, 'fired', 'served', $9)`,
      [
        ulidToUuid(createUlid()),
        world.tenantId,
        outletId,
        ulidToUuid(orderUlid),
        menuItemId,
        name,
        quantity,
        20000 * quantity,
        dateOf(new Date()),
      ],
    ),
  );
}

/** audit_logs rows of the tenant whose text mentions `needle` (schema-agnostic). */
export async function auditRowsMentioning(
  tenantId: string,
  needle: string,
): Promise<string[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ t: string }>(
      "SELECT a::text AS t FROM audit_logs a WHERE a.tenant_id = $1 AND a::text LIKE $2",
      [tenantId, `%${needle}%`],
    );
    return rows.map((r) => r.t);
  });
}
