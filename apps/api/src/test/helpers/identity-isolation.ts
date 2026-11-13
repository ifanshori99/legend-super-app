// Row isolation for the identity test files (bead legend-5opkl).
//
// `user_identities`, `login_challenges`, `wa_inbound_messages`, `identity_merges`
// and the `@wa.invalid` placeholder accounts are shared by every identity test
// file, and vitest runs files in parallel workers. A file that deletes or counts
// the whole table breaks its neighbours. Each file therefore owns a scope: its
// own tenants (and so its own receiving numbers and challenges), its own sender
// numbers and the accounts those produce. Cleanup and counts touch only that
// scope; nothing here deletes globally.

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { whatsAppDigest } from "../../lib/identity-digest";
import { mapKirimdevSender, unmapKirimdevSender } from "./kirimdev-sender.ts";

const tenantLimits = {
  maxOutlets: 2,
  maxActiveEmployees: 5,
  maxDevices: 2,
  aiRequestsPerMonth: 0,
  whatsappCostCapIdr: 0,
  aiCostCapIdr: 0,
  emailCostCapIdr: 0,
};

// identity_merges is append-only; the owner connection may switch the guard off
// for cleanup. Switching it is DDL on a shared table, so files take this lock
// first: one file must not re-enable the guard under another's delete.
const MERGE_GUARD_LOCK = 7_300_511;

/** 62 + 8 random digits after a fixed 3-digit prefix: unique per call. */
export function uniqueDigits(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");
}

export type IdentityTenant = {
  id: string;
  hostname: string;
  receivingNumber: string;
};

/**
 * A tenant with a verified host and an active WhatsApp integration on its own
 * receiving number, so challenges issued on that host are routed to it only.
 */
export async function createIdentityTenant(
  owner: Pool,
  label: string,
  receivingNumber: string,
  options: { id?: string; withDomain?: boolean } = {},
): Promise<IdentityTenant> {
  const id = options.id ?? randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const hostname = `id-${label}-${suffix}.contoh.example`;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', $4, $5)`,
    [
      id,
      `id-${label}-${suffix}`,
      `Uji ${label}`,
      JSON.stringify(tenantLimits),
      // The platform tenant list parses created_by as a user id (uuid).
      randomUUID(),
    ],
  );
  if (options.withDomain !== false) {
    const brandId = randomUUID();
    await owner.query(
      "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand Uji')",
      [brandId, id, `id-${suffix}`],
    );
    await owner.query(
      `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
       VALUES ($1, $2, $3, $4, 'custom', 'active', now())`,
      [randomUUID(), id, brandId, hostname],
    );
  }
  await setIntegrationNumber(owner, id, receivingNumber);
  return { id, hostname, receivingNumber };
}

export async function setIntegrationNumber(
  owner: Pool,
  tenantId: string,
  receivingNumber: string,
) {
  await owner.query(
    `INSERT INTO tenant_integrations (tenant_id, provider, config, credentials_encrypted, status)
     VALUES ($1, 'whatsapp', $2, 'c2VhbGVkLXRlc3Q=', 'active')
     ON CONFLICT (tenant_id, provider) WHERE outlet_id IS NULL
     DO UPDATE SET config = EXCLUDED.config, status = EXCLUDED.status`,
    [tenantId, JSON.stringify({ vendor: "kirimdev", receivingNumber })],
  );
  // Inbound routing reads kirimdev_sender_mappings only (legend-52tdq), so the
  // webhook's phone_number_id (the receiving number here) must be mapped.
  await mapKirimdevSender(tenantId, receivingNumber);
}

export type IdentityScopeInput = {
  /** Tenants whose challenges, inbound rows and merges belong to the file. */
  tenantIds: string[];
  /** Receiving numbers the file's inbound rows came in on. */
  receivingNumbers: string[];
  /** Sender numbers (digits) the file's accounts are created from. */
  senders: string[];
  /** Accounts the file created by other means (signUp, seeds). */
  userIds: string[];
};

/** Deletes merges touching `userIds` under the guard lock (one file at a time). */
export async function deleteMergesOf(owner: Pool, userIds: string[]) {
  if (userIds.length === 0) return;
  const client = await owner.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MERGE_GUARD_LOCK]);
    try {
      await client.query("ALTER TABLE identity_merges DISABLE TRIGGER USER");
      try {
        await client.query(
          "DELETE FROM identity_merges WHERE survivor_user_id = ANY($1) OR absorbed_user_id = ANY($1)",
          [userIds],
        );
      } finally {
        await client.query("ALTER TABLE identity_merges ENABLE TRIGGER USER");
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MERGE_GUARD_LOCK]);
    }
  } finally {
    client.release();
  }
}

export function createIdentityScope(owner: Pool) {
  const scope: IdentityScopeInput = {
    tenantIds: [],
    receivingNumbers: [],
    senders: [],
    userIds: [],
  };

  /** Accounts this file owns: its numbers, its challenges, its tracked users and their merge partners. */
  async function ownedUserIds(): Promise<string[]> {
    const hashes = await Promise.all(scope.senders.map(whatsAppDigest));
    const found = await owner.query<{ id: string }>(
      `SELECT user_id::text AS id FROM user_identities WHERE value_hash = ANY($1)
       UNION SELECT matched_user_id::text FROM login_challenges
              WHERE tenant_id = ANY($2) AND matched_user_id IS NOT NULL
       UNION SELECT link_user_id::text FROM login_challenges
              WHERE tenant_id = ANY($2) AND link_user_id IS NOT NULL`,
      [hashes, scope.tenantIds],
    );
    const ids = new Set([...found.rows.map((r) => r.id), ...scope.userIds]);
    // A merge moves the WhatsApp identity to the survivor and leaves the
    // absorbed placeholder behind; both belong to the file.
    const merged = await owner.query<{ id: string }>(
      `SELECT survivor_user_id::text AS id FROM identity_merges
         WHERE survivor_user_id = ANY($1) OR absorbed_user_id = ANY($1)
       UNION SELECT absorbed_user_id::text FROM identity_merges
         WHERE survivor_user_id = ANY($1) OR absorbed_user_id = ANY($1)`,
      [[...ids]],
    );
    for (const row of merged.rows) ids.add(row.id);
    return [...ids];
  }

  /** Removes only this file's rows. Explicitly tracked accounts go whatever their e-mail. */
  async function cleanup() {
    const ids = await ownedUserIds();
    await owner.query(
      `DELETE FROM wa_inbound_messages
        WHERE tenant_id = ANY($1) OR receiving_number = ANY($2)`,
      [scope.tenantIds, scope.receivingNumbers],
    );
    await owner.query(
      "DELETE FROM login_challenges WHERE tenant_id = ANY($1)",
      [scope.tenantIds],
    );
    await deleteMergesOf(owner, ids);
    await owner.query("DELETE FROM user_identities WHERE user_id = ANY($1)", [
      ids,
    ]);
    const deletable = await owner.query<{ id: string }>(
      `SELECT id FROM "user"
        WHERE id = ANY($1) AND (email LIKE '%@wa.invalid' OR id = ANY($2))`,
      [ids, scope.userIds],
    );
    const userIds = deletable.rows.map((r) => r.id);
    if (userIds.length > 0) {
      await owner.query(
        "DELETE FROM role_assignments WHERE user_id = ANY($1::text[]) OR assigned_by = ANY($1::text[])",
        [userIds],
      );
      await owner.query(
        "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
        [userIds],
      );
      await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
        userIds,
      ]);
    }
    scope.userIds.length = 0;
  }

  /** Drops the file's own tenants after a final cleanup. */
  async function dropTenants(tenantIds: string[]) {
    await owner.query(
      "DELETE FROM wa_inbound_messages WHERE tenant_id = ANY($1)",
      [tenantIds],
    );
    await owner.query(
      "DELETE FROM login_challenges WHERE tenant_id = ANY($1)",
      [tenantIds],
    );
    await owner.query(
      "DELETE FROM tenant_integrations WHERE tenant_id = ANY($1)",
      [tenantIds],
    );
    for (const tenantId of tenantIds) await unmapKirimdevSender(tenantId);
    await owner.query("DELETE FROM tenant_domains WHERE tenant_id = ANY($1)", [
      tenantIds,
    ]);
    await owner.query("DELETE FROM brands WHERE tenant_id = ANY($1)", [
      tenantIds,
    ]);
    await owner.query("DELETE FROM tenants WHERE id = ANY($1)", [tenantIds]);
  }

  /** Row counts limited to the file's scope (a whole-table count sees other files). */
  async function count(
    table:
      | "login_challenges"
      | "wa_inbound_messages"
      | "user_identities"
      | "identity_merges"
      | "session",
  ): Promise<number> {
    const ids = await ownedUserIds();
    const queries = {
      login_challenges: [
        "SELECT count(*)::int AS n FROM login_challenges WHERE tenant_id = ANY($1)",
        [scope.tenantIds],
      ],
      wa_inbound_messages: [
        "SELECT count(*)::int AS n FROM wa_inbound_messages WHERE tenant_id = ANY($1) OR receiving_number = ANY($2)",
        [scope.tenantIds, scope.receivingNumbers],
      ],
      user_identities: [
        "SELECT count(*)::int AS n FROM user_identities WHERE user_id = ANY($1)",
        [ids],
      ],
      identity_merges: [
        "SELECT count(*)::int AS n FROM identity_merges WHERE survivor_user_id = ANY($1) OR absorbed_user_id = ANY($1)",
        [ids],
      ],
      session: [
        "SELECT count(*)::int AS n FROM session WHERE user_id = ANY($1)",
        [ids],
      ],
    } as const;
    const [sql, params] = queries[table];
    const { rows } = await owner.query<{ n: number }>(sql, [...params]);
    return rows[0]!.n;
  }

  return { scope, ownedUserIds, cleanup, dropTenants, count };
}
