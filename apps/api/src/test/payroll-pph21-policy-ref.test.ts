// PPh 21 policy ref hash (review K, B2): `pph21ParametersHash` is stable
// under key order and `pph21PolicyForRun` compares it, so a pinned version
// whose parameters differ from what was pinned is PAYROLL_SNAPSHOT_MISMATCH.
// No database.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { businessDateSchema } from "@starter/shared/core";
import {
  DEFAULT_PPH21_POLICY,
  canonicalJson,
  isSamePph21PolicyRef,
  pph21ParametersHash,
  pph21PolicyForRun,
  pph21PolicyRef,
  sha256Hex,
  type Pph21PolicyParameters,
  type Pph21PolicyVersion,
} from "@starter/shared/hris/payroll";

const date = (value: string) => businessDateSchema.parse(value);

const version = (
  parameters: Pph21PolicyParameters,
  effectiveFrom = "2026-11-10",
): Pph21PolicyVersion => ({
  id: randomUUID() as never,
  tenantId: randomUUID() as never,
  version: 1,
  effectiveFrom: date(effectiveFrom),
  parameters,
  reason: "Test",
  createdBy: randomUUID() as never,
  createdAt: "2026-11-08T03:00:00.000Z",
});

describe("sha256Hex", () => {
  it("matches node:crypto, including multi-block and non-ASCII input", () => {
    for (const text of [
      "",
      "abc",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(64),
      "a".repeat(1000),
      "Rp 1.000.000 é中",
    ])
      expect(sha256Hex(text)).toBe(
        createHash("sha256").update(text, "utf8").digest("hex"),
      );
  });
});

describe("pph21ParametersHash", () => {
  it("is independent of key order and sensitive to every value", () => {
    const shuffled = {
      roundingMode: "half_up",
      mixedSchemeAllocation: "proportional",
      combinedSpouseStatus: "normalize",
      noTaxIdSurcharge: "ter_and_annual",
      occupationalCostCap: "pro_rata_months",
    } as Pph21PolicyParameters;
    expect(pph21ParametersHash(shuffled)).toBe(
      pph21ParametersHash(DEFAULT_PPH21_POLICY),
    );
    expect(canonicalJson(shuffled)).toBe(
      '{"combinedSpouseStatus":"normalize","mixedSchemeAllocation":"proportional","noTaxIdSurcharge":"ter_and_annual","occupationalCostCap":"pro_rata_months","roundingMode":"half_up"}',
    );
    expect(pph21ParametersHash(DEFAULT_PPH21_POLICY)).toMatch(/^[0-9a-f]{64}$/);
    for (const changed of [
      { roundingMode: "down" },
      { mixedSchemeAllocation: "gross_first" },
      { occupationalCostCap: "full_annual" },
      { noTaxIdSurcharge: "annual_only" },
      { combinedSpouseStatus: "reject" },
    ] as Partial<Pph21PolicyParameters>[])
      expect(
        pph21ParametersHash({ ...DEFAULT_PPH21_POLICY, ...changed }),
      ).not.toBe(pph21ParametersHash(DEFAULT_PPH21_POLICY));
  });
});

describe("pph21PolicyForRun parameters hash", () => {
  const stored = version({ ...DEFAULT_PPH21_POLICY, roundingMode: "down" });
  const ref = pph21PolicyRef(stored);
  const frozen = (pph21Policy: typeof ref) => ({
    status: "locked" as const,
    payDate: date("2026-11-28"),
    configSnapshot: { pph21Policy },
  });

  it("stores the hash in the ref of a draft run", () => {
    const draft = pph21PolicyForRun(
      { status: "draft", payDate: date("2026-11-28"), configSnapshot: null },
      [stored],
    );
    expect(draft.ref).toEqual(ref);
    expect(ref.parametersHash).toBe(pph21ParametersHash(stored.parameters));
  });

  it("accepts a frozen run whose pinned parameters hash matches", () => {
    const result = pph21PolicyForRun(frozen(ref), [stored]);
    expect(result.parameters).toBe(stored.parameters);
    expect(result.ref).toEqual(ref);
  });

  it("refuses a frozen run when the stored parameters differ from the pinned hash", () => {
    // Same id, number and date; a parameter changed outside the service.
    const edited = { ...stored, parameters: DEFAULT_PPH21_POLICY };
    expect(() => pph21PolicyForRun(frozen(ref), [edited])).toThrow(
      expect.objectContaining({ code: "PAYROLL_SNAPSHOT_MISMATCH" }),
    );
    // A wrong hash in the snapshot is refused the same way.
    expect(() =>
      pph21PolicyForRun(frozen({ ...ref, parametersHash: "0".repeat(64) }), [
        stored,
      ]),
    ).toThrow(expect.objectContaining({ code: "PAYROLL_SNAPSHOT_MISMATCH" }));
  });
});

describe("isSamePph21PolicyRef", () => {
  const ref = pph21PolicyRef(version(DEFAULT_PPH21_POLICY));
  it("compares null and every field including the hash", () => {
    expect(isSamePph21PolicyRef(null, null)).toBe(true);
    expect(isSamePph21PolicyRef(ref, null)).toBe(false);
    expect(isSamePph21PolicyRef(null, ref)).toBe(false);
    expect(isSamePph21PolicyRef(ref, { ...ref })).toBe(true);
    expect(isSamePph21PolicyRef(ref, { ...ref, version: 2 })).toBe(false);
    expect(
      isSamePph21PolicyRef(ref, { ...ref, effectiveFrom: date("2026-12-01") }),
    ).toBe(false);
    expect(
      isSamePph21PolicyRef(ref, { ...ref, parametersHash: "1".repeat(64) }),
    ).toBe(false);
  });
});
