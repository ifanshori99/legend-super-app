// legend-fy5y architect F2: an identity conflict leaves emailVerified false;
// the flag is set only after the identity row is settled.
import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { emailDigest } from "../lib/identity-digest";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { markEmailVerifiedWithIdentity } from "../services/identity-email-login.service";
import {
  owner,
  scopedContext,
  seedInvitationTenant,
} from "./tenant-invitation-helpers";

afterAll(async () => {
  await owner.end();
});

it("markEmailVerifiedWithIdentity keeps emailVerified false on identity_conflict", async () => {
  const seed = await seedInvitationTenant();
  const address = seed.email.toLowerCase();
  const digest = await emailDigest(address);
  const otherUser = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Pemilik Lain', $2, true)`,
    [otherUser, `lain-${otherUser}@example.test`],
  );
  await owner.query(
    `INSERT INTO user_identities (id, user_id, type, value_hash, value_encrypted, verified_at)
     VALUES ($1, $2, 'email', $3, 'c2VhbGVk', now())`,
    [randomUUID(), otherUser, digest],
  );
  const result = await withTenant(db, scopedContext(seed.tenantId), (tx) =>
    markEmailVerifiedWithIdentity(tx, {
      userId: seed.userId,
      email: address,
      digest,
      isPrimary: false,
      now: new Date(),
    }),
  );
  expect(result).toBe("identity_conflict");
  const { rows } = await owner.query<{ email_verified: boolean }>(
    'SELECT email_verified FROM "user" WHERE id = $1',
    [seed.userId],
  );
  expect(rows[0]!.email_verified).toBe(false);
});
