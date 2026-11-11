// legend-fy5y architect F1: minting never cancels an earlier pending link, so a
// retried send whose first response was lost leaves the delivered link usable.
// Accepting one link cancels the user's other pending invitation links.
import { afterAll, describe, expect, it } from "vitest";
import { magicLinkTokenDigest } from "../lib/identity-digest";
import {
  acceptInvitationLink,
  issueInvitationLink,
} from "../services/identity-invitation.service";
import {
  owner,
  scopedContext,
  seedInvitationTenant,
  tokenOfLink,
  type SeededInvitation,
} from "./tenant-invitation-helpers";

const ORIGIN = "https://app.legend.example.test";

async function mintToken(seed: SeededInvitation, now = new Date()) {
  const link = await issueInvitationLink(scopedContext(seed.tenantId), {
    userId: seed.userId,
    origin: ORIGIN,
    now,
  });
  if (!link) throw new Error("expected an invitation link");
  return tokenOfLink(link);
}

async function statusOf(token: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM login_challenges WHERE code_hash = $1",
    [magicLinkTokenDigest(token)],
  );
  return rows[0]!.status;
}

afterAll(async () => {
  await owner.end();
});

describe("legend-fy5y invitation retry (F1)", () => {
  it("a retried mint leaves the first link usable", async () => {
    const seed = await seedInvitationTenant();
    const now = new Date();
    const first = await mintToken(seed, now);
    // The response carrying `first` was lost; the sender retries and mints again.
    const second = await mintToken(seed, now);
    expect(await statusOf(first)).toBe("pending");
    expect(await statusOf(second)).toBe("pending");
    await acceptInvitationLink(
      { token: first, tenantId: seed.tenantId },
      { now },
    );
    const { rows } = await owner.query<{ email_verified: boolean }>(
      'SELECT email_verified FROM "user" WHERE id = $1',
      [seed.userId],
    );
    expect(rows[0]!.email_verified).toBe(true);
  });

  it("accepting one link cancels the other pending links of the user", async () => {
    const seed = await seedInvitationTenant();
    const now = new Date();
    const first = await mintToken(seed, now);
    const second = await mintToken(seed, now);
    await acceptInvitationLink(
      { token: second, tenantId: seed.tenantId },
      { now },
    );
    expect(await statusOf(second)).toBe("completed");
    expect(await statusOf(first)).toBe("cancelled");
    await expect(
      acceptInvitationLink({ token: first, tenantId: seed.tenantId }, { now }),
    ).rejects.toMatchObject({ code: "CHALLENGE_NOT_PENDING" });
  });
});
