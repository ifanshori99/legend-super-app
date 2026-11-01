// Shared core conventions contract tests (WS-00, bead legend-6gu):
// ids (UUID + ULID), money (BIGINT rupiah + NUMERIC(14,4)), tenant context
// (TEN-02), outlet scope (TEN-03), error envelope, cursor pagination, ISO
// date rules and the Cafe Legend fixtures. Loaded with plain Node ESM and its
// built-in type stripping, with no resolve hook: the sources must import
// exactly as the API and the edge runtime will load them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import * as core from "../packages/shared/src/core/index.ts";
import * as server from "../packages/shared/src/core/server.ts";

const coreUrl = new URL(
  "../packages/shared/src/core/index.ts",
  import.meta.url,
);
const serverUrl = new URL(
  "../packages/shared/src/core/server.ts",
  import.meta.url,
);

function runNode(source) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  });
}

describe("module loading", () => {
  test("both entry points import under native Node ESM without hooks", () => {
    const result = runNode(
      `const core = await import(${JSON.stringify(coreUrl.href)});
       const server = await import(${JSON.stringify(serverUrl.href)});
       if (typeof core.idr !== "function" || typeof server.establishTenantContext !== "function") process.exit(2);`,
    );
    assert.equal(result.status, 0, result.stderr);
  });

  test("server entry refuses to load where a DOM exists", () => {
    const result = runNode(
      `globalThis.document = {}; await import(${JSON.stringify(serverUrl.href)});`,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /server-only/);
  });

  test("browser-safe entry exposes checks but no way to mint access", () => {
    for (const name of [
      "establishTenantContext",
      "establishOutletScope",
      "establishScopedTenantContext",
      "mintTenantContext",
      "mintOutletScope",
    ])
      assert.equal(name in core, false, name);
    assert.equal(typeof core.assertTrustedTenantContext, "function");
  });
});

describe("ids", () => {
  test("ULID: monotonic, sortable, canonical, timestamp round-trips", () => {
    const now = Date.UTC(2026, 10, 1, 13, 0, 0);
    const next = core.createUlidFactory({ now: () => now });
    const a = next();
    const b = next();
    const c = next();
    for (const id of [a, b, c])
      assert.ok(core.ulidSchema.safeParse(id).success);
    assert.ok(a < b && b < c, "same-millisecond ULIDs stay ordered");
    assert.equal(core.ulidTimestamp(a), now);
    const later = core.createUlid(now + 1);
    assert.ok(later > c);
  });

  test("ULID <-> UUID storage conversion is lossless and order-preserving", () => {
    const ids = [
      core.createUlid(Date.UTC(2026, 0, 1)),
      core.createUlid(Date.UTC(2026, 5, 1)),
      core.createUlid(Date.UTC(2027, 0, 1)),
    ];
    const stored = ids.map(core.ulidToUuid);
    for (const [index, uuid] of stored.entries()) {
      assert.match(
        uuid,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      assert.equal(core.uuidToUlid(uuid), ids[index]);
    }
    assert.deepEqual([...stored].sort(), stored, "byte order = time order");
    assert.equal(
      core.ulidToUuid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
      // Independently computed: base32 -> 128-bit integer -> hex.
      "01563e3a-b5d3-d676-4c61-efb99302bd5b",
    );
  });

  test("ULID schema normalizes case, rejects wrong length and overflow", () => {
    assert.equal(
      core.ulidSchema.parse("01arz3ndektsv4rrffq69g5fav"),
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    assert.equal(
      core.uuidToUlid(core.ulidToUuid("01arz3ndektsv4rrffq69g5fav")),
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    for (const bad of [
      "01ARZ3NDEKTSV4RRFFQ69G5FA",
      "81ARZ3NDEKTSV4RRFFQ69G5FAV",
      "01ARZ3NDEKTSV4RRFFQ69G5FAU",
    ])
      assert.equal(core.ulidSchema.safeParse(bad).success, false, bad);
  });

  test("branded id schemas validate UUIDs", () => {
    const id = core.cafeLegendFixtures.tenant.id;
    assert.equal(core.tenantIdSchema.parse(id), id);
    assert.throws(() => core.tenantIdSchema.parse("cafe-legend"));
  });

  test("UUIDs normalize to lowercase so ids compare with ===", () => {
    const lower = core.cafeLegendFixtures.tenant.id;
    const upper = lower.toUpperCase();
    assert.equal(core.tenantIdSchema.parse(upper), lower);
    assert.equal(core.uuidSchema.parse(upper), lower);
    assert.equal(core.tenantIdSchema.parse(lower), lower);
  });
});

describe("money (BIGINT rupiah)", () => {
  test("idr() accepts only safe integers", () => {
    assert.equal(core.idr(25_000), 25_000);
    assert.equal(core.idr(-5_000), -5_000);
    for (const bad of [1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, Infinity])
      assert.throws(() => core.idr(bad), RangeError, String(bad));
    assert.equal(core.idrSchema.safeParse(1.5).success, false);
    assert.equal(core.idrSchema.safeParse("25000").success, false);
  });

  test("arithmetic stays exact and refuses overflow", () => {
    assert.equal(
      core.sumIdr([core.idr(10_000), core.idr(2_500), core.idr(-500)]),
      12_000,
    );
    assert.equal(core.subtractIdr(core.idr(10_000), core.idr(12_500)), -2_500);
    assert.equal(core.multiplyIdr(core.idr(18_000), 3), 54_000);
    assert.equal(core.negateIdr(core.idr(0)), 0);
    assert.ok(Object.is(core.negateIdr(core.idr(0)), 0), "no -0");
    assert.throws(
      () => core.addIdr(core.idr(Number.MAX_SAFE_INTEGER), core.idr(1)),
      RangeError,
    );
    assert.throws(() => core.multiplyIdr(core.idr(10), 1.5), RangeError);
  });

  test("rounding modes", () => {
    const cases = [
      // [numerator, denominator, half_up, half_even, down, floor, ceil]
      [5n, 2n, 3, 2, 2, 2, 3],
      [7n, 2n, 4, 4, 3, 3, 4],
      [-5n, 2n, -3, -2, -2, -3, -2],
      [10n, 3n, 3, 3, 3, 3, 4],
      [-10n, 3n, -3, -3, -3, -4, -3],
      [9n, 3n, 3, 3, 3, 3, 3],
    ];
    for (const [n, d, halfUp, halfEven, down, floor, ceil] of cases) {
      assert.equal(core.divideRounded(n, d, "half_up"), BigInt(halfUp));
      assert.equal(core.divideRounded(n, d, "half_even"), BigInt(halfEven));
      assert.equal(core.divideRounded(n, d, "down"), BigInt(down));
      assert.equal(core.divideRounded(n, d, "floor"), BigInt(floor));
      assert.equal(core.divideRounded(n, d, "ceil"), BigInt(ceil));
    }
    assert.throws(() => core.divideRounded(1n, 0n, "half_up"), RangeError);
  });

  test("basis points and ratios (PBJT 10% = 1000 bp)", () => {
    assert.equal(
      core.applyBasisPoints(core.idr(125_000), 1_000, "half_up"),
      12_500,
    );
    assert.equal(
      core.applyBasisPoints(core.idr(33_333), 1_000, "half_up"),
      3_333,
    );
    assert.equal(
      core.applyBasisPoints(core.idr(33_335), 1_000, "half_up"),
      3_334,
    );
    assert.equal(
      core.applyBasisPoints(core.idr(33_335), 1_000, "half_even"),
      3_334,
    );
    assert.equal(
      core.applyBasisPoints(core.idr(33_325), 1_000, "half_even"),
      3_332,
    );
    assert.equal(
      core.applyRatio(core.idr(120_000), 11, 12, "half_up"),
      110_000,
    );
    assert.equal(core.basisPointsSchema.safeParse(10_000).success, true);
    assert.equal(core.basisPointsSchema.safeParse(10_001).success, false);
  });

  test("roundToIncrement returns the rounded amount and the rounding line", () => {
    assert.deepEqual(core.roundToIncrement(core.idr(137_450), 100, "half_up"), {
      amount: 137_500,
      adjustment: 50,
    });
    assert.deepEqual(core.roundToIncrement(core.idr(137_449), 100, "half_up"), {
      amount: 137_400,
      adjustment: -49,
    });
    assert.deepEqual(core.roundToIncrement(core.idr(137_449), 1, "half_up"), {
      amount: 137_449,
      adjustment: 0,
    });
    assert.throws(
      () => core.roundToIncrement(core.idr(1), 0, "half_up"),
      RangeError,
    );
  });

  test("ORD-06: allocation sums exactly to the bill, including rounding", () => {
    assert.deepEqual(
      core.splitIdrEvenly(core.idr(137_500), 3),
      [45_834, 45_833, 45_833],
    );
    assert.deepEqual(core.allocateIdr(core.idr(100), [1, 1, 1]), [34, 33, 33]);
    assert.deepEqual(
      core.allocateIdr(core.idr(-100), [1, 1, 1]),
      [-34, -33, -33],
    );
    assert.deepEqual(
      core.allocateIdr(core.idr(1_000), [0, 3, 1]),
      [0, 750, 250],
    );
    // Profit share: versioned allocations sum to 10,000 bp.
    assert.deepEqual(
      core.allocateIdr(core.idr(10_000_001), [4_000, 3_000, 2_000, 1_000]),
      [4_000_001, 3_000_000, 2_000_000, 1_000_000],
    );
    // Property: any total and weights split exactly.
    let seed = 7;
    const random = () =>
      (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    for (let run = 0; run < 500; run += 1) {
      const total = core.idr((random() % 20_000_000) - 10_000_000);
      const weights = Array.from(
        { length: 1 + (random() % 7) },
        () => random() % 50_000,
      );
      if (weights.every((weight) => weight === 0)) weights[0] = 1;
      const parts = core.allocateIdr(total, weights);
      assert.equal(core.sumIdr(parts), total);
      weights.forEach((weight, index) => {
        if (weight === 0) assert.equal(parts[index], 0);
      });
    }
    assert.throws(() => core.allocateIdr(core.idr(100), []), RangeError);
    assert.throws(() => core.allocateIdr(core.idr(100), [0, 0]), RangeError);
    assert.throws(() => core.allocateIdr(core.idr(100), [1, -1]), RangeError);
    assert.throws(() => core.splitIdrEvenly(core.idr(100), 0), RangeError);
  });
});

describe("NUMERIC(14,4) quantities and unit costs", () => {
  test("schema accepts DB/wire decimal strings, rejects floats and overflow", () => {
    for (const ok of [
      "0",
      "1.5",
      "-2.25",
      "9999999999.9999",
      "0.0001",
      "1250.0000",
    ])
      assert.equal(core.decimal4Schema.safeParse(ok).success, true, ok);
    for (const bad of [
      "1.23456",
      "10000000000",
      "1e3",
      "",
      ".5",
      "1.",
      1.5,
      "+1",
    ])
      assert.equal(
        core.decimal4Schema.safeParse(bad).success,
        false,
        String(bad),
      );
  });

  test("parse/format round-trip to canonical 4 dp", () => {
    assert.equal(core.parseDecimal4("1.5"), 15_000n);
    assert.equal(core.parseDecimal4("-0.0001"), -1n);
    assert.equal(core.formatDecimal4(15_000n), "1.5000");
    assert.equal(core.formatDecimal4(-1n), "-0.0001");
    assert.equal(core.formatDecimal4(0n), "0.0000");
    assert.throws(() => core.formatDecimal4(100_000_000_000_000n), RangeError);
  });

  test("extended cost: quantity x unit cost -> whole rupiah", () => {
    // 0.0180 kg coffee at Rp 245.000/kg = Rp 4.410
    assert.equal(
      core.extendCostIdr(
        core.decimal4("0.0180"),
        core.decimal4("245000"),
        "half_up",
      ),
      4_410,
    );
    // 3 g milk powder at Rp 87.3333/g = Rp 261.9999 -> 262
    assert.equal(
      core.extendCostIdr(
        core.decimal4("3"),
        core.decimal4("87.3333"),
        "half_up",
      ),
      262,
    );
    assert.equal(
      core.multiplyDecimal4(
        core.decimal4("1.5"),
        core.decimal4("0.3333"),
        "half_up",
      ),
      "0.5000",
    );
  });

  test("unit cost of a received line", () => {
    // Rp 262.000 for 3 kg = Rp 87.333,3333 per kg
    assert.equal(
      core.unitCostOf(core.idr(262_000), core.decimal4("3"), "half_up"),
      "87333.3333",
    );
    assert.throws(
      () => core.unitCostOf(core.idr(1), core.decimal4("0"), "half_up"),
      RangeError,
    );
  });
});

describe("tenant context (TEN-02)", () => {
  const { tenant } = core.cafeLegendFixtures;
  const domainContext = () =>
    server.establishTenantContext({
      tenantId: tenant.id,
      source: "domain",
      brandId: null,
    });

  test("server-minted context is frozen and trusted", () => {
    const context = domainContext();
    assert.equal(context.tenantId, tenant.id);
    assert.ok(Object.isFrozen(context));
    assert.equal(core.isTrustedTenantContext(context), true);
    core.assertTrustedTenantContext(context);
  });

  test("plain objects, JSON round-trips and copies are rejected at runtime", () => {
    const context = domainContext();
    const forgeries = [
      { tenantId: tenant.id, brandId: null, source: "domain" },
      JSON.parse(JSON.stringify(context)),
      structuredClone(context),
      { ...context },
      Object.create(context),
      null,
      undefined,
      tenant.id,
    ];
    for (const forged of forgeries) {
      assert.equal(core.isTrustedTenantContext(forged), false);
      assert.throws(() => core.assertTrustedTenantContext(forged), TypeError);
    }
  });

  test("client-chosen sources and ids are refused", () => {
    assert.throws(() =>
      server.establishTenantContext({
        tenantId: tenant.id,
        source: "client",
        brandId: null,
      }),
    );
    assert.throws(() =>
      server.establishTenantContext({
        tenantId: "cafe-legend",
        source: "domain",
        brandId: null,
      }),
    );
    assert.throws(() =>
      server.establishTenantContext({
        tenantId: tenant.id,
        source: "domain",
        brandId: null,
        extra: true,
      }),
    );
    const context = server.establishTenantContext({
      tenantId: tenant.id.toUpperCase(),
      source: "session",
      brandId: null,
    });
    assert.equal(context.tenantId, tenant.id, "normalized to lowercase");
  });

  test("client input schemas refuse tenant fields at definition and parse time", () => {
    assert.throws(
      () => core.clientInputSchema({ tenantId: core.tenantIdSchema }),
      TypeError,
    );
    assert.throws(
      () => core.clientInputSchema({ tenant_id: core.tenantIdSchema }),
      TypeError,
    );
    const schema = core.clientInputSchema({ note: core.z.string() });
    assert.equal(
      schema.safeParse({ note: "x", tenantId: tenant.id }).success,
      false,
    );
    assert.equal(
      schema.safeParse({ note: "x", tenant_id: tenant.id }).success,
      false,
    );
    assert.deepEqual(schema.parse({ note: "x" }), { note: "x" });
  });
});

describe("outlet scope (TEN-03)", () => {
  const { tenant, outlets } = core.cafeLegendFixtures;
  const [bandung, second] = outlets;
  const otherTenantId = "5d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6";
  const context = server.establishTenantContext({
    tenantId: tenant.id,
    source: "session",
    brandId: null,
  });
  const owner = server.establishOutletScope(context, { kind: "tenant" });
  const cashier = server.establishOutletScope(
    context,
    core.cafeLegendFixtures.cashierScope,
  );

  test("membership follows the verified assignment, ids case-insensitive", () => {
    assert.equal(core.isOutletInScope(owner, second.id), true);
    assert.equal(core.isOutletInScope(cashier, bandung.id), true);
    assert.equal(core.isOutletInScope(cashier, bandung.id.toUpperCase()), true);
    assert.equal(core.isOutletInScope(cashier, second.id), false);
    assert.equal(owner.tenantId, tenant.id);
    assert.ok(Object.isFrozen(cashier) && Object.isFrozen(cashier.outletIds));
  });

  test("forged scopes never grant access (fail closed)", () => {
    const forgeries = [
      { kind: "tenant", tenantId: tenant.id },
      { kind: "tenant" },
      JSON.parse(JSON.stringify(owner)),
      { ...owner },
      { ...cashier, outletIds: [bandung.id, second.id] },
    ];
    for (const forged of forgeries) {
      assert.equal(core.isTrustedOutletScope(forged), false);
      assert.throws(() => core.isOutletInScope(forged, second.id), TypeError);
      assert.throws(() => core.outletIdsForQuery(forged), TypeError);
    }
  });

  test("scope needs a trusted tenant and stays bound to it", () => {
    assert.throws(
      () =>
        server.establishOutletScope(
          { tenantId: tenant.id, brandId: null, source: "domain" },
          { kind: "tenant" },
        ),
      TypeError,
    );
    assert.throws(() =>
      server.establishOutletScope(context, { kind: "outlets", outletIds: [] }),
    );
    const scoped = server.establishScopedTenantContext(context, {
      kind: "tenant",
    });
    core.assertTrustedScopedContext(scoped);
    const otherTenant = server.establishTenantContext({
      tenantId: otherTenantId,
      source: "domain",
      brandId: null,
    });
    assert.throws(
      () =>
        core.assertTrustedScopedContext({
          tenant: otherTenant,
          outletScope: scoped.outletScope,
        }),
      TypeError,
    );
    assert.throws(
      () => core.assertTrustedScopedContext(JSON.parse(JSON.stringify(scoped))),
      TypeError,
    );
  });

  test("report/export/AI outlet filter: cross-outlet requests are denied", () => {
    assert.deepEqual(core.outletIdsForQuery(owner), { kind: "all" });
    assert.deepEqual(core.outletIdsForQuery(owner, [second.id]), {
      kind: "outlets",
      outletIds: [second.id],
    });
    assert.deepEqual(core.outletIdsForQuery(cashier), {
      kind: "outlets",
      outletIds: [bandung.id],
    });
    assert.deepEqual(core.outletIdsForQuery(cashier, []), {
      kind: "outlets",
      outletIds: [bandung.id],
    });
    assert.deepEqual(
      core.outletIdsForQuery(cashier, [bandung.id.toUpperCase(), bandung.id]),
      { kind: "outlets", outletIds: [bandung.id] },
    );
    for (const requested of [[second.id], [bandung.id, second.id]]) {
      assert.throws(
        () => core.outletIdsForQuery(cashier, requested),
        (error) =>
          error instanceof core.CoreError &&
          error.code === "OUTLET_OUT_OF_SCOPE" &&
          error.status === 403,
      );
    }
    assert.throws(() => core.outletIdsForQuery(cashier, ["not-an-id"]));
    assert.throws(
      () => core.assertOutletInScope(cashier, second.id),
      core.CoreError,
    );
    core.assertOutletInScope(cashier, bandung.id);
  });
});

describe("error envelope", () => {
  test("every core code maps to an HTTP status and builds a valid body", () => {
    for (const code of core.CORE_ERROR_CODES) {
      const status = core.coreErrorHttpStatus[code];
      assert.ok(status >= 400 && status < 600, code);
      const body = core.apiErrorBody(code, "Pesan");
      assert.ok(core.apiErrorBodySchema.safeParse(body).success, code);
    }
  });

  test("starter codes stay compatible and domain codes are UPPER_SNAKE", () => {
    for (const code of [
      "VALIDATION_ERROR",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "NOT_FOUND",
      "INTERNAL_ERROR",
      "INVALID_JSON",
      "PAYLOAD_TOO_LARGE",
    ])
      assert.ok(core.CORE_ERROR_CODES.includes(code), code);
    assert.ok(core.errorCodeSchema.safeParse("PERIOD_CLOSED").success);
    assert.equal(core.errorCodeSchema.safeParse("periodClosed").success, false);
    assert.ok(
      core.isApiErrorBody({
        error: { code: "NOT_FOUND", message: "Tidak ditemukan" },
      }),
    );
    assert.equal(core.isApiErrorBody({ message: "x" }), false);
  });
});

describe("cursor pagination", () => {
  test("query defaults and limits", () => {
    assert.deepEqual(core.cursorPageQuerySchema.parse({}), { limit: 25 });
    assert.deepEqual(
      core.cursorPageQuerySchema.parse({ limit: "50", cursor: "abc" }),
      { limit: 50, cursor: "abc" },
    );
    assert.equal(
      core.cursorPageQuerySchema.safeParse({ limit: 101 }).success,
      false,
    );
    assert.equal(
      core.cursorPageQuerySchema.safeParse({ offset: 10 }).success,
      false,
    );
  });

  test("cursor encodes a keyset tuple opaquely and round-trips unicode", () => {
    const keyset = [
      "2026-11-01T13:00:00.000Z",
      "01JBQ7Z8K3M4N5P6Q7R8S9T0VW",
      "Kopi Susu Gula Aren ☕",
      3,
      null,
    ];
    const cursor = core.encodeCursor(keyset);
    assert.match(cursor, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(core.decodeCursor(cursor), keyset);
    for (const bad of [
      "%%%",
      core.encodeCursor([]).slice(0, 1),
      "eyJhIjoxfQ",
      "A".repeat(core.CURSOR_MAX_LENGTH + 4),
    ])
      assert.throws(() => core.decodeCursor(bad), RangeError, bad.slice(0, 20));
  });

  test("encoder and query schema share one length limit", () => {
    const accepts = (cursor) =>
      core.cursorPageQuerySchema.safeParse({ cursor }).success;
    // Longest bounded keyset: timestamp, ULID, 150-code-point name of 4-byte chars.
    const longest = [
      "2026-11-01T13:00:00.000Z",
      "01JBQ7Z8K3M4N5P6Q7R8S9T0VW",
      "🍰".repeat(150),
    ];
    const cursor = core.encodeCursor(longest);
    assert.ok(cursor.length <= core.CURSOR_MAX_LENGTH);
    assert.ok(accepts(cursor));
    assert.deepEqual(core.decodeCursor(cursor), longest);
    // The reviewer's case: a 500-character ASCII key now fits too.
    assert.ok(accepts(core.encodeCursor(["x".repeat(500)])));
    // Unbounded keys are refused by the encoder, never emitted.
    assert.throws(() => core.encodeCursor(["ꦗ".repeat(500)]), RangeError);
    // Property: anything the encoder emits, the query schema accepts.
    for (let size = 0; size < 800; size += 7) {
      const key = "é☕🍰a".repeat(size).slice(0, size);
      let encoded;
      try {
        encoded = core.encodeCursor([key, size]);
      } catch (error) {
        assert.ok(error instanceof RangeError);
        continue;
      }
      assert.ok(accepts(encoded), `size ${size}`);
      assert.deepEqual(core.decodeCursor(encoded), [key, size]);
    }
  });

  test("page schema", () => {
    const page = core.cursorPageSchema(core.z.object({ id: core.ulidSchema }));
    assert.ok(
      page.safeParse({ data: [], meta: { limit: 25, nextCursor: null } })
        .success,
    );
    assert.equal(
      page.safeParse({ data: [], meta: { limit: 25 } }).success,
      false,
    );
  });
});

describe("dates and times", () => {
  test("instant, business date and time-of-day schemas", () => {
    assert.ok(
      core.isoDateTimeSchema.safeParse("2026-11-01T13:00:00.000Z").success,
    );
    assert.ok(
      core.isoDateTimeSchema.safeParse("2026-11-01T20:00:00+07:00").success,
    );
    assert.equal(
      core.isoDateTimeSchema.safeParse("2026-11-01 13:00").success,
      false,
    );
    assert.equal(
      core.isoDateTimeSchema.safeParse("2026-11-01T13:00:00").success,
      false,
      "offset required",
    );
    assert.ok(core.businessDateSchema.safeParse("2026-11-01").success);
    assert.equal(
      core.businessDateSchema.safeParse("2026-02-30").success,
      false,
    );
    assert.ok(core.timeOfDaySchema.safeParse("07:30").success);
    assert.equal(core.timeOfDaySchema.safeParse("24:00").success, false);
  });

  test("business date follows the outlet time zone", () => {
    // 18:30 UTC on 1 Nov is already 2 Nov in Bandung (UTC+7).
    assert.equal(
      core.businessDateOf("2026-11-01T18:30:00.000Z", core.DEFAULT_TIME_ZONE),
      "2026-11-02",
    );
    assert.equal(
      core.businessDateOf(new Date("2026-11-01T16:59:59.000Z"), "Asia/Jakarta"),
      "2026-11-01",
    );
    assert.equal(
      core.toIsoDateTime(new Date(Date.UTC(2026, 10, 1, 13))),
      "2026-11-01T13:00:00.000Z",
    );
  });

  test("business date range 0001-01-01..9999-12-31, zero-padded years", () => {
    const at = (iso, zone) => core.businessDateOf(new Date(iso), zone);
    assert.equal(at("0001-01-01T00:00:00.000Z", "UTC"), "0001-01-01");
    assert.equal(at("0999-06-15T00:00:00.000Z", "UTC"), "0999-06-15");
    assert.equal(at("9999-12-31T23:59:59.999Z", "UTC"), "9999-12-31");
    // 23:00 UTC on 31 Dec 1 BC is already 1 Jan AD 1 in Jakarta.
    assert.equal(at("0000-12-31T23:00:00.000Z", "Asia/Jakarta"), "0001-01-01");
    assert.throws(() => at("0000-12-31T23:00:00.000Z", "UTC"), RangeError);
    assert.throws(
      () => at("9999-12-31T20:00:00.000Z", "Asia/Jakarta"),
      RangeError,
    );
    assert.throws(() => core.businessDateOf(new Date(Number.NaN)), RangeError);
  });
});

describe("Cafe Legend fixtures", () => {
  test("every fixture parses against its schema", () => {
    const f = core.cafeLegendFixtures;
    core.tenantRefSchema.parse(f.tenant);
    core.brandRefSchema.parse(f.brand);
    for (const outlet of f.outlets) core.outletRefSchema.parse(outlet);
    core.outletScopeDataSchema.parse(f.cashierScope);
    core.apiErrorBodySchema.parse(f.errors.outletOutOfScope);
    core.cursorPageSchema(core.moneyLineFixtureSchema).parse(f.orderLinesPage);
    for (const line of f.orderLinesPage.data)
      core.moneyLineFixtureSchema.parse(line);
    core.ulidSchema.parse(f.orderId);
    assert.equal(core.uuidToUlid(core.ulidToUuid(f.orderId)), f.orderId);
  });

  test("fixture order lines add up (PBJT 10%)", () => {
    const lines = core.cafeLegendFixtures.orderLinesPage.data;
    const subtotal = core.sumIdr(lines.map((line) => line.lineTotalIdr));
    assert.equal(subtotal, 125_000);
    assert.equal(core.applyBasisPoints(subtotal, 1_000, "half_up"), 12_500);
  });
});
