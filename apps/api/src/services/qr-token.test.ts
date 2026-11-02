// ORD-04: signed table QR tokens. A token is bound to one tenant/outlet/table
// by its signature; editing the payload or replaying it in another tenant is
// refused, and a rotated token has a different hash so the old sticker no
// longer resolves. The service-level tests in table-session-api.test.ts cover
// the scan and the closed-session rejection end to end.

import { describe, expect, it } from "vitest";
import { CoreError } from "@starter/shared/core";
import { qrTokenHash, signTableQrToken, verifyTableQrToken } from "./qr-token";

const tenantA = "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f601";
const tenantB = "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f602";
const outletA = "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01";
const tableA = "7b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d01";

function expectUnknown(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe("NOT_FOUND");
    return;
  }
  throw new Error("Expected the token to be refused");
}

describe("signed table QR", () => {
  it("ORD-04 signs a v1 token and verifies it for its own tenant", () => {
    const token = signTableQrToken({
      tenantId: tenantA,
      outletId: outletA,
      tableId: tableA,
      issuedAt: new Date("2026-11-02T10:00:00.000Z"),
    });
    expect(token.startsWith("v1.")).toBe(true);
    const verified = verifyTableQrToken({
      token,
      resolvedTenantId: tenantA,
    });
    expect(verified.payload).toMatchObject({
      version: 1,
      tenantId: tenantA,
      outletId: outletA,
      tableId: tableA,
      issuedAt: "2026-11-02T10:00:00.000Z",
    });
    expect(verified.hash).toBe(qrTokenHash(token));
    expect(verified.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("ORD-04 refuses a token of another tenant without an id oracle", () => {
    const token = signTableQrToken({
      tenantId: tenantA,
      outletId: outletA,
      tableId: tableA,
    });
    expectUnknown(() =>
      verifyTableQrToken({ token, resolvedTenantId: tenantB }),
    );
  });

  it("ORD-04 refuses an edited payload, a rotated sticker and a malformed token", () => {
    const token = signTableQrToken({
      tenantId: tenantA,
      outletId: outletA,
      tableId: tableA,
    });
    const [prefix, encoded, signature] = token.split(".");
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    const forged = Buffer.from(
      JSON.stringify({ ...payload, tableId: tenantB }),
      "utf8",
    ).toString("base64url");
    expectUnknown(() =>
      verifyTableQrToken({
        token: `${prefix}.${forged}.${signature}`,
        resolvedTenantId: tenantA,
      }),
    );
    expectUnknown(() =>
      verifyTableQrToken({
        token: `${prefix}.${encoded}.${"A".repeat(43)}`,
        resolvedTenantId: tenantA,
      }),
    );
    expectUnknown(() =>
      verifyTableQrToken({
        token: "v1.not-a-token",
        resolvedTenantId: tenantA,
      }),
    );

    // "Ganti QR": the reissued token has a new payload (issuedAt) and hash, so
    // the old sticker's hash no longer resolves (ORD-04).
    const rotated = signTableQrToken({
      tenantId: tenantA,
      outletId: outletA,
      tableId: tableA,
      issuedAt: new Date(Date.now() + 1_000),
    });
    expect(rotated).not.toBe(token);
    expect(qrTokenHash(rotated)).not.toBe(qrTokenHash(token));
  });
});
