// Audited WhatsApp unlink + outlet authorization (bead legend-7wzy; PRD v1.7
// §3 F6 "Graf Identitas Pelanggan", §6 B audit_logs / user_identities, TEN-01,
// TEN-02, TEN-03).
//
// Written fail-first from the PRD and the shared access/identity contracts, not
// from the service. The unlink endpoint does not exist yet, so THE CONTRACT
// BELOW IS AN ASSUMPTION the engineer may adjust (change the constants, not the
// intent):
//
//   DELETE /api/outlets/:outletId/customers/:userId/identities/:identityId
//     body { reason } (required, non-empty)
//     - same outlet-in-path convention as GET /api/outlets/:outletId/floor;
//     - tenant comes from the Host (TEN-02), never from path or body;
//     - needs `crm.customer.identity.unlink` (Owner and Admin Tenant) on the
//       outlet, a FRESH second factor, and a reason. The read permission
//       `crm.customer.pii.read` alone is refused (403);
//     - one number is one account across tenants, so the global
//       user_identities row is NEVER deleted by staff: the unlink only clears
//       whatsapp_hash / whatsapp_verified_at on THIS tenant's customer
//       profile (other tenants' profiles and the login stay untouched), which
//       frees the number for a new profile of this tenant;
//     - success is 204 (200 accepted);
//     - one audit_logs row is appended in the same transaction:
//         action "identity.unlinked", objectType "user_identity",
//         objectId = identity id, tenantId, outletId, actorType "user",
//         actorId = staff user id, reason = the body reason, the target
//         customer id present in the event, and no raw number, digest or
//         ciphertext anywhere in the event;
//     - refusals: 401 anonymous, 403 no authorization on the outlet, 422 no
//       reason, 404 when the identity does not belong to a customer of the
//       caller's tenant (no existence leak across tenants); a refusal writes
//       no audit row and leaves the profile linked;
//     - if the audit insert fails the unlink fails and the profile stays.
//
// audit_logs is append-only, so rows are matched by this run's random ids.

import { randomBytes, randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { originHeader, verifySessionMfa } from "./helpers";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  owner,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffOfIsolatedTenant,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers";

const UNLINK_ACTION = "identity.unlinked";
const UNLINK_PERMISSION = "crm.customer.identity.unlink";
const REASON = "Nomor lama sudah dipakai orang lain";
const unlinkPath = (outletId: string, userId: string, identityId: string) =>
  `/api/outlets/${outletId}/customers/${userId}/identities/${identityId}`;

type AuditEvent = {
  action: string;
  objectType: string;
  objectId: string | null;
  tenantId: string;
  outletId?: string | null;
  actorType: string;
  actorId: string | null;
  reason?: string | null;
  maskedChanges?: { before: unknown; after: unknown } | null;
};

let app: Express;
let ownerA: Staff;
let ownerNoMfa: Staff;
let ownerStaleMfa: Staff;
// outlet_manager holds crm.customer.pii.read but not the unlink permission.
let managerA: Staff;
// Holds the unlink permission through a custom role, on outlet B only.
let unlinkerB: Staff;
let waiterA: Staff;
let isolated: IsolatedTenant;
let foreignStaff: Staff;
const customerUserIds: string[] = [];
const staffUserIds: string[] = [];
const grantedRoleIds: string[] = [];
let customRoleId: string | null = null;

function hex64(): string {
  return randomBytes(32).toString("hex");
}

async function seedUser(): Promise<string> {
  const userId = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'Pelanggan Unlink', $2, false, now(), now())`,
    [userId, `unlink-${userId}@wa.invalid`],
  );
  customerUserIds.push(userId);
  return userId;
}

async function seedProfile(tenantId: string, userId: string, digest: string) {
  await owner.query(
    `INSERT INTO customer_profiles
       (id, tenant_id, user_id, whatsapp_hash, name, membership_status, whatsapp_verified_at)
     VALUES ($1, $2, $3, $4, 'Pelanggan Unlink', 'active', now())`,
    [randomUUID(), tenantId, userId, digest],
  );
}

/** A customer of `tenantId` with one verified WhatsApp identity. */
async function seedCustomer(tenantId: string) {
  const userId = await seedUser();
  const digest = hex64();
  const identity = await owner.query<{ id: string }>(
    `INSERT INTO user_identities (user_id, type, value_hash, verified_at, is_primary)
     VALUES ($1, 'whatsapp', $2, now(), true) RETURNING id`,
    [userId, digest],
  );
  await seedProfile(tenantId, userId, digest);
  return { userId, identityId: identity.rows[0]!.id, digest };
}

type Customer = Awaited<ReturnType<typeof seedCustomer>>;

type ProfileRow = {
  whatsapp_hash: string | null;
  whatsapp_verified_at: Date | null;
  membership_status: string;
};

async function profileOf(
  tenantId: string,
  userId: string,
): Promise<ProfileRow> {
  const { rows } = await owner.query<ProfileRow>(
    `SELECT whatsapp_hash, whatsapp_verified_at, membership_status
       FROM customer_profiles WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
  return rows[0]!;
}

/** The profile of the seeded tenant still carries the number. */
async function stillLinked(customer: Customer): Promise<boolean> {
  const profile = await profileOf(seededTenantId, customer.userId);
  return profile.whatsapp_hash === customer.digest;
}

/** Staff unlink request; the body carries the reason unless overridden. */
function unlink(
  staff: Staff,
  customer: { userId: string; identityId: string },
  options: { outletId?: string; body?: object | null } = {},
) {
  const request = staff.client
    .delete(
      unlinkPath(
        options.outletId ?? seededOutletA,
        customer.userId,
        customer.identityId,
      ),
    )
    .set(originHeader);
  return options.body === null
    ? request
    : request.send(options.body ?? { reason: REASON });
}

async function identityExists(identityId: string): Promise<boolean> {
  const { rows } = await owner.query(
    "SELECT 1 FROM user_identities WHERE id = $1",
    [identityId],
  );
  return rows.length === 1;
}

async function auditOf(identityId: string): Promise<AuditEvent[]> {
  const { rows } = await owner.query<{ event: AuditEvent }>(
    `SELECT event FROM audit_logs
      WHERE event->>'action' = $1 AND event->>'objectId' = $2
      ORDER BY id`,
    [UNLINK_ACTION, identityId],
  );
  return rows.map((row) => row.event);
}

/** Makes every unlink audit insert of the seeded tenant fail, like a broken store. */
async function failUnlinkAudit() {
  const name = `fail_unlink_audit_${randomBytes(6).toString("hex")}`;
  await owner.query(
    `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW.tenant_id = '${seededTenantId}' AND NEW.event->>'action' = '${UNLINK_ACTION}' THEN
         RAISE EXCEPTION 'injected audit failure';
       END IF;
       RETURN NEW;
     END $$`,
  );
  await owner.query(
    `CREATE TRIGGER ${name} BEFORE INSERT ON public.audit_logs
     FOR EACH ROW EXECUTE FUNCTION public.${name}()`,
  );
  return async () => {
    await owner.query(`DROP TRIGGER IF EXISTS ${name} ON public.audit_logs`);
    await owner.query(`DROP FUNCTION IF EXISTS public.${name}()`);
  };
}

beforeAll(async () => {
  app = createApp();
  // The stored template rows are what the resolver reads (the catalog is not):
  // give the Owner and Admin Tenant rows of the seeded tenant the new
  // permission the way a role backfill would, and undo it in afterAll.
  const granted = await owner.query<{ id: string }>(
    `UPDATE roles SET permissions = permissions || $2::jsonb
      WHERE tenant_id = $1 AND is_template
        AND template_key IN ('owner', 'tenant_admin')
        AND NOT (permissions @> $2::jsonb)
      RETURNING id`,
    [seededTenantId, JSON.stringify([UNLINK_PERMISSION])],
  );
  grantedRoleIds.push(...granted.rows.map((row) => row.id));
  ownerA = await staffWithRole(app, { template: "owner", label: "Owner A" });
  ownerNoMfa = await staffWithRole(app, {
    template: "owner",
    label: "Owner Tanpa MFA",
  });
  ownerStaleMfa = await staffWithRole(app, {
    template: "owner",
    label: "Owner MFA Basi",
  });
  managerA = await staffWithRole(app, {
    template: "outlet_manager",
    scopeType: "outlet",
    scopeId: seededOutletA,
    label: "Manager Outlet A",
  });
  unlinkerB = await staffWithRole(app, {
    template: "waiter",
    scopeType: "outlet",
    scopeId: seededOutletB,
    label: "Unlinker Outlet B",
  });
  customRoleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Unlink Outlet B', false, NULL, $3, true, '["outlet"]')`,
    [customRoleId, seededTenantId, JSON.stringify([UNLINK_PERMISSION])],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [seededTenantId, unlinkerB.userId, customRoleId, seededOutletB],
  );
  waiterA = await staffWithRole(app, {
    template: "waiter",
    scopeType: "outlet",
    scopeId: seededOutletA,
    label: "Waiter Outlet A",
  });
  // Management roles need a verified second factor (AUTH-05).
  await verifySessionMfa(ownerA.email);
  await verifySessionMfa(managerA.email);
  await verifySessionMfa(unlinkerB.email);
  await owner.query(
    `UPDATE "session" SET mfa_verified_at = now() - interval '1 hour'
      WHERE revoked_at IS NULL AND user_id = $1`,
    [ownerStaleMfa.userId],
  );
  isolated = await createIsolatedTenant(`unlink-${randomUUID().slice(0, 6)}`);
  await owner.query(
    "UPDATE roles SET permissions = permissions || $2::jsonb WHERE id = $1",
    [isolated.roleId, JSON.stringify([UNLINK_PERMISSION])],
  );
  foreignStaff = await staffOfIsolatedTenant(app, isolated);
  await verifySessionMfa(foreignStaff.email);
  staffUserIds.push(
    ownerA.userId,
    ownerNoMfa.userId,
    ownerStaleMfa.userId,
    managerA.userId,
    unlinkerB.userId,
    waiterA.userId,
    foreignStaff.userId,
  );
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM customer_profiles WHERE user_id = ANY($1::text[])",
    [customerUserIds],
  );
  await owner.query(
    "DELETE FROM user_identities WHERE user_id = ANY($1::text[])",
    [customerUserIds],
  );
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    customerUserIds,
  ]);
  await owner.query(
    "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
    [staffUserIds],
  );
  if (customRoleId)
    await owner.query("DELETE FROM roles WHERE id = $1", [customRoleId]);
  if (grantedRoleIds.length > 0)
    await owner.query(
      `UPDATE roles SET permissions = permissions - $2::text
        WHERE id = ANY($1::uuid[])`,
      [grantedRoleIds, UNLINK_PERMISSION],
    );
  if (isolated) await dropIsolatedTenant(isolated);
  await owner.end();
});

describe("F6 audited WhatsApp unlink (legend-7wzy)", () => {
  it("F6 §6 B an authorized owner unlinks the number; the audit row names actor, target, tenant, outlet and reason", async () => {
    const customer = await seedCustomer(seededTenantId);

    const response = await unlink(ownerA, customer);
    expect([200, 204]).toContain(response.status);

    const events = await auditOf(customer.identityId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: UNLINK_ACTION,
      objectType: "user_identity",
      objectId: customer.identityId,
      tenantId: seededTenantId,
      outletId: seededOutletA,
      actorType: "user",
      actorId: ownerA.userId,
      reason: REASON,
    });
    const stored = JSON.stringify(events);
    // Target customer is identifiable...
    expect(stored).toContain(customer.userId);
    // ...but the identity value itself (digest) is never stored (PII).
    expect(stored).not.toContain(customer.digest);
  });

  it("F6 the unlink never deletes the global identity: the person's login and other tenants stay intact", async () => {
    const customer = await seedCustomer(seededTenantId);
    // The same person is also a customer of another tenant.
    await seedProfile(isolated.tenantId, customer.userId, customer.digest);

    const response = await unlink(ownerA, customer);
    expect([200, 204]).toContain(response.status);

    expect(await identityExists(customer.identityId)).toBe(true);
    const other = await profileOf(isolated.tenantId, customer.userId);
    expect(other.whatsapp_hash).toBe(customer.digest);
    expect(other.whatsapp_verified_at).not.toBeNull();
    expect(other.membership_status).toBe("active");
  });

  it("F6 the unlink clears the number on this tenant's profile only", async () => {
    const customer = await seedCustomer(seededTenantId);
    await seedProfile(isolated.tenantId, customer.userId, customer.digest);

    const response = await unlink(ownerA, customer);
    expect([200, 204]).toContain(response.status);

    const own = await profileOf(seededTenantId, customer.userId);
    expect(own.whatsapp_hash).toBeNull();
    expect(own.whatsapp_verified_at).toBeNull();
    // An active profile needs a verified number, so it waits for a new one.
    expect(own.membership_status).toBe("pending_verification");
  });

  it("F6 the same number can be recycled to a new profile of this tenant after the unlink", async () => {
    const customer = await seedCustomer(seededTenantId);
    const newcomer = await seedUser();
    // Before the unlink the tenant already has a profile for this number.
    await expect(
      seedProfile(seededTenantId, newcomer, customer.digest),
    ).rejects.toMatchObject({ code: "23505" });

    const response = await unlink(ownerA, customer);
    expect([200, 204]).toContain(response.status);

    await seedProfile(seededTenantId, newcomer, customer.digest);
    const recycled = await profileOf(seededTenantId, newcomer);
    expect(recycled.whatsapp_hash).toBe(customer.digest);
  });

  it("F6 unlinking the same identity twice does not write a second audit row", async () => {
    const customer = await seedCustomer(seededTenantId);

    const first = await unlink(ownerA, customer);
    expect([200, 204]).toContain(first.status);
    const second = await unlink(ownerA, customer);
    expect(second.status).toBe(404);
    expect(await auditOf(customer.identityId)).toHaveLength(1);
  });

  it("F6 an unknown identity id is a 404 with no audit row", async () => {
    const customer = await seedCustomer(seededTenantId);
    const missing = randomUUID();
    const response = await unlink(ownerA, {
      userId: customer.userId,
      identityId: missing,
    });
    expect(response.status).toBe(404);
    expect(await auditOf(missing)).toHaveLength(0);
    expect(await stillLinked(customer)).toBe(true);
  });

  it("F6 TEN-03 when the audit write fails the unlink fails and the number stays linked", async () => {
    const customer = await seedCustomer(seededTenantId);
    const restore = await failUnlinkAudit();
    try {
      const response = await unlink(ownerA, customer);
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      await restore();
    }
    expect(await stillLinked(customer)).toBe(true);
    expect(await identityExists(customer.identityId)).toBe(true);
    expect(await auditOf(customer.identityId)).toHaveLength(0);
  });
});

describe("F6 reason and fresh second factor of the unlink (legend-7wzy)", () => {
  it.each([
    ["no body", null],
    ["an empty body", {}],
    ["a blank reason", { reason: "   " }],
    ["an over-long reason", { reason: "x".repeat(501) }],
    ["a tenant id instead of a reason", { tenantId: seededTenantId }],
  ])(
    "F6 %s is refused (422): nothing changes and no audit row",
    async (_name, body) => {
      const customer = await seedCustomer(seededTenantId);
      const response = await unlink(ownerA, customer, { body });
      expect(response.status).toBe(422);
      expect(await stillLinked(customer)).toBe(true);
      expect(await auditOf(customer.identityId)).toHaveLength(0);
    },
  );

  it("F6 an owner session without any second factor is refused (403)", async () => {
    const customer = await seedCustomer(seededTenantId);
    const response = await unlink(ownerNoMfa, customer);
    expect(response.status).toBe(403);
    expect(await stillLinked(customer)).toBe(true);
    expect(await auditOf(customer.identityId)).toHaveLength(0);
  });

  it("F6 a stale second factor is refused (401 re-auth)", async () => {
    const customer = await seedCustomer(seededTenantId);
    const response = await unlink(ownerStaleMfa, customer);
    expect(response.status).toBe(401);
    expect(await stillLinked(customer)).toBe(true);
    expect(await auditOf(customer.identityId)).toHaveLength(0);
  });
});

describe("F6 outlet authorization of WhatsApp identity operations (legend-7wzy)", () => {
  it("F6 staff who only hold crm.customer.pii.read (outlet manager) are refused (403)", async () => {
    const customer = await seedCustomer(seededTenantId);
    const response = await unlink(managerA, customer);
    expect(response.status).toBe(403);
    expect(await stillLinked(customer)).toBe(true);
    expect(await auditOf(customer.identityId)).toHaveLength(0);
  });

  it("F6 staff holding the permission on a different outlet are refused (403) and nothing changes", async () => {
    const customer = await seedCustomer(seededTenantId);
    const response = await unlink(unlinkerB, customer, {
      outletId: seededOutletA,
    });
    expect(response.status).toBe(403);
    expect(await stillLinked(customer)).toBe(true);
    expect(await auditOf(customer.identityId)).toHaveLength(0);
  });

  it("F6 staff holding the permission on the outlet in the path are allowed", async () => {
    const customer = await seedCustomer(seededTenantId);
    const response = await unlink(unlinkerB, customer, {
      outletId: seededOutletB,
    });
    expect([200, 204]).toContain(response.status);
    expect((await auditOf(customer.identityId))[0]).toMatchObject({
      outletId: seededOutletB,
      actorId: unlinkerB.userId,
    });
  });

  it("F6 staff whose role lacks the permission is refused (403) even on their own outlet", async () => {
    const customer = await seedCustomer(seededTenantId);
    const response = await unlink(waiterA, customer);
    expect(response.status).toBe(403);
    expect(await stillLinked(customer)).toBe(true);
    expect(await auditOf(customer.identityId)).toHaveLength(0);
  });

  it("F6 an anonymous caller is refused (401)", async () => {
    const customer = await seedCustomer(seededTenantId);
    const { default: request } = await import("supertest");
    const response = await request(app)
      .delete(unlinkPath(seededOutletA, customer.userId, customer.identityId))
      .set(originHeader)
      .send({ reason: REASON });
    expect(response.status).toBe(401);
    expect(await stillLinked(customer)).toBe(true);
    expect(await auditOf(customer.identityId)).toHaveLength(0);
  });
});

describe("TEN-01 TEN-02 tenant isolation of WhatsApp unlink (legend-7wzy)", () => {
  it("TEN-01 staff of another tenant cannot unlink a customer's number through their own outlet (404, no leak)", async () => {
    const customer = await seedCustomer(seededTenantId);
    const response = await foreignStaff.client
      .delete(
        unlinkPath(isolated.outletId, customer.userId, customer.identityId),
      )
      .set({ ...originHeader, Host: isolated.hostname })
      .send({ reason: REASON });
    expect(response.status).toBe(404);
    expect(await identityExists(customer.identityId)).toBe(true);
    expect(await stillLinked(customer)).toBe(true);
    expect(await auditOf(customer.identityId)).toHaveLength(0);
  });

  it("TEN-01 staff of another tenant cannot reach this tenant's outlet by id (403 or 404)", async () => {
    const customer = await seedCustomer(seededTenantId);
    const response = await foreignStaff.client
      .delete(unlinkPath(seededOutletA, customer.userId, customer.identityId))
      .set({ ...originHeader, Host: isolated.hostname })
      .send({ reason: REASON });
    expect([403, 404]).toContain(response.status);
    expect(await identityExists(customer.identityId)).toBe(true);
    expect(await stillLinked(customer)).toBe(true);
    expect(await auditOf(customer.identityId)).toHaveLength(0);
  });

  it("TEN-02 a tenant id in the body or query is ignored; the Host decides the tenant", async () => {
    const customer = await seedCustomer(seededTenantId);
    const response = await foreignStaff.client
      .delete(
        `${unlinkPath(isolated.outletId, customer.userId, customer.identityId)}?tenantId=${seededTenantId}`,
      )
      .set({ ...originHeader, Host: isolated.hostname })
      .send({ tenantId: seededTenantId, reason: REASON });
    expect([400, 404, 422]).toContain(response.status);
    expect(await identityExists(customer.identityId)).toBe(true);
    expect(await stillLinked(customer)).toBe(true);
    expect(await auditOf(customer.identityId)).toHaveLength(0);
  });

  it("TEN-01 a successful unlink audit row lands only in the caller's tenant", async () => {
    const customer = await seedCustomer(seededTenantId);
    const response = await unlink(ownerA, customer);
    expect([200, 204]).toContain(response.status);
    const { rows } = await owner.query(
      `SELECT 1 FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = $2`,
      [isolated.tenantId, UNLINK_ACTION],
    );
    expect(rows).toHaveLength(0);
  });
});
