// Shared core conventions contract tests (WS-00, bead legend-6gu):
// ids (UUID + ULID), money (BIGINT rupiah + NUMERIC(14,4)), tenant context
// (TEN-02), outlet scope (TEN-03), error envelope, cursor pagination, ISO
// date rules and the Cafe Legend fixtures. Loads the TypeScript sources
// directly through Node type stripping.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, test } from "node:test";

// Shared sources use bundler-style extensionless imports; let Node try ".ts".
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const core = await import("../packages/shared/src/core/index.ts");

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

  test("ULID schema rejects lowercase, wrong length and overflow", () => {
    for (const bad of [
      "01arz3ndektsv4rrffq69g5fav",
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

describe("tenant context (TEN-02) and outlet scope (TEN-03)", () => {
  const { tenant, outlets } = core.cafeLegendFixtures;

  test("context comes only from a server source and is frozen", () => {
    const context = core.establishTenantContext({
      tenantId: tenant.id,
      source: "domain",
      brandId: null,
    });
    assert.equal(context.tenantId, tenant.id);
    assert.ok(Object.isFrozen(context));
    assert.throws(() =>
      core.establishTenantContext({
        tenantId: tenant.id,
        source: "client",
        brandId: null,
      }),
    );
    assert.throws(() =>
      core.establishTenantContext({
        tenantId: "x",
        source: "domain",
        brandId: null,
      }),
    );
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
    assert.deepEqual(schema.parse({ note: "x" }), { note: "x" });
  });

  test("outlet scope", () => {
    const [bandung, second] = outlets;
    const all = core.outletScopeSchema.parse({ kind: "tenant" });
    const one = core.outletScopeSchema.parse({
      kind: "outlets",
      outletIds: [bandung.id],
    });
    assert.equal(core.isOutletInScope(all, second.id), true);
    assert.equal(core.isOutletInScope(one, bandung.id), true);
    assert.equal(core.isOutletInScope(one, second.id), false);
    assert.equal(
      core.outletScopeSchema.safeParse({ kind: "outlets", outletIds: [] })
        .success,
      false,
    );
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
    for (const bad of ["%%%", core.encodeCursor([]).slice(0, 1), "eyJhIjoxfQ"])
      assert.throws(() => core.decodeCursor(bad), RangeError, bad);
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
});

describe("Cafe Legend fixtures", () => {
  test("every fixture parses against its schema", () => {
    const f = core.cafeLegendFixtures;
    core.tenantRefSchema.parse(f.tenant);
    core.brandRefSchema.parse(f.brand);
    for (const outlet of f.outlets) core.outletRefSchema.parse(outlet);
    core.outletScopeSchema.parse(f.cashierScope);
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
