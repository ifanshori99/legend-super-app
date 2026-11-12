// Custom-domain verification UI pure logic (bead legend-az8z5; mockup
// design/mockups/platform/domain-verification.html). Loaded with native Node
// type stripping, like the sources.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";
import {
  DOMAIN_COPY,
  classifyDomainError,
  customDomains,
  domainNotice,
  domainScreen,
  domainView,
  normalizeDomainInput,
  validateHostname,
} from "../apps/web/src/features/ws01-org/domain-state.ts";

describe("classifyDomainError", () => {
  test("maps the three contract codes", () => {
    assert.equal(
      classifyDomainError(new ApiError(422, "DOMAIN_VERIFICATION_FAILED", "x")),
      "verification_failed",
    );
    assert.equal(
      classifyDomainError(new ApiError(422, "DOMAIN_RESERVED", "x")),
      "reserved",
    );
    assert.equal(
      classifyDomainError(new ApiError(409, "DOMAIN_TAKEN", "x")),
      "taken",
    );
  });

  test("network failures and anything else", () => {
    assert.equal(classifyDomainError(new TypeError("fetch failed")), "network");
    assert.equal(classifyDomainError({ status: 0 }), "network");
    assert.equal(
      classifyDomainError(new ApiError(500, "INTERNAL", "x")),
      "unknown",
    );
    assert.equal(classifyDomainError(undefined), "unknown");
  });
});

describe("domainNotice", () => {
  test("uses the mockup copy", () => {
    assert.deepEqual(domainNotice("verification_failed"), {
      title: "Verifikasi belum berhasil.",
      message:
        "Record TXT belum ditemukan. Periksa nama dan nilai di pengelola DNS, lalu coba lagi.",
    });
    assert.deepEqual(domainNotice("reserved"), {
      title: "Domain tidak dapat digunakan.",
      message:
        "Domain ini dicadangkan dan tidak dapat digunakan. Pilih domain lain.",
    });
    assert.deepEqual(domainNotice("taken"), {
      title: "Domain tidak dapat digunakan.",
      message: "Domain ini sudah digunakan. Pilih domain lain.",
    });
  });

  test("network and unknown say how to recover", () => {
    assert.match(domainNotice("network").message, /coba lagi/);
    assert.match(domainNotice("unknown").message, /Coba lagi/);
  });
});

describe("hostname input", () => {
  test("normalizes case, port and trailing dot", () => {
    assert.equal(normalizeDomainInput("  Pesan.Contoh.ID. "), "pesan.contoh.id");
    assert.equal(normalizeDomainInput("pesan.contoh.id:443"), "pesan.contoh.id");
  });

  test("rejects non-public names", () => {
    for (const bad of [
      "contoh",
      "localhost",
      "app.local",
      "192.168.0.1",
      "[::1]",
      "-a.contoh.id",
      "pesan contoh.id",
      "https://pesan.contoh.id",
      "a..id",
    ])
      assert.equal(normalizeDomainInput(bad), null, bad);
  });

  test("validateHostname gives a message or the normalized host", () => {
    assert.deepEqual(validateHostname("   "), {
      ok: false,
      message: DOMAIN_COPY.hostnameRequired,
    });
    assert.deepEqual(validateHostname("contoh"), {
      ok: false,
      message: DOMAIN_COPY.hostnameInvalid,
    });
    assert.deepEqual(validateHostname("Pesan.Contoh.id"), {
      ok: true,
      hostname: "pesan.contoh.id",
    });
  });
});

describe("domain view", () => {
  const record = { type: "TXT", name: "_legend-verification.a.id", value: "v" };

  test("pending until verifiedAt is set", () => {
    assert.equal(
      domainView({ kind: "custom", verifiedAt: null, verification: record }),
      "pending",
    );
    assert.equal(
      domainView({
        kind: "custom",
        verifiedAt: "2026-11-12T01:00:00.000Z",
        verification: null,
      }),
      "verified",
    );
  });

  test("only custom domains are listed; none means the empty screen", () => {
    const rows = [
      { kind: "platform_subdomain", id: 1 },
      { kind: "custom", id: 2 },
    ];
    assert.deepEqual(customDomains(rows), [{ kind: "custom", id: 2 }]);
    assert.equal(domainScreen(rows), "list");
    assert.equal(domainScreen([rows[0]]), "empty");
    assert.equal(domainScreen([]), "empty");
  });
});
