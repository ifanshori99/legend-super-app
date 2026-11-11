// Statutory table publish guard (money area, PAYR-02). Two PUBLISHED versions
// of one table type with the same effectiveFrom make the rate in force
// ambiguous, so payroll would fail closed (PAYROLL_STATUTORY_TABLE_AMBIGUOUS)
// at run time. Publishing must refuse that state up front: the shared
// `publishStatutoryVersion` takes the sibling versions as `existing`.
//
// ASSUMPTIONS: `existing` is optional (callers that omit it keep the old
// behaviour); the version being published may itself appear in `existing`
// and is ignored by id; only status "published" siblings of the SAME type
// count (drafts, archived and other types never clash).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BusinessDate } from "@starter/shared/core";
import {
  cafeLegendPayrollFixtures,
  PayrollError,
  publishStatutoryVersion,
  resolveStatutoryTable,
} from "@starter/shared/hris/payroll";
import type {
  StatutoryTableVersion,
  StatutoryTableVersionId,
} from "@starter/shared/hris/payroll";

const { financeApprover } = cafeLegendPayrollFixtures.userIds;
const published = cafeLegendPayrollFixtures.statutoryTables;
const thrBase = published.find((v) => v.type === "thr");
const jhtBase = published.find((v) => v.type === "jht");
if (!thrBase || !jhtBase) throw new TypeError("fixture lacks thr/jht tables");

const TODAY = "2026-11-11" as BusinessDate;
const DATE = "2027-03-01" as BusinessDate;
const OTHER_DATE = "2027-04-01" as BusinessDate;
const AT = "2026-11-11T03:00:00.000Z";
const options = { today: TODAY, actorId: financeApprover, at: AT };

type Base = StatutoryTableVersion;
const draftOf = (
  base: Base,
  effectiveFrom: BusinessDate,
  status: "draft" | "archived" = "draft",
): Base => ({
  ...base,
  id: randomUUID() as StatutoryTableVersionId,
  version: base.version + 1,
  effectiveFrom,
  status,
  publishedAt: null,
  publishedBy: null,
});
const publishedOf = (base: Base, effectiveFrom: BusinessDate): Base => ({
  ...base,
  id: randomUUID() as StatutoryTableVersionId,
  version: base.version + 1,
  effectiveFrom,
  status: "published",
  publishedAt: "2026-11-01T03:00:00.000Z",
  publishedBy: financeApprover,
});

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}
const publish = (version: Base, existing?: readonly Base[]) =>
  publishStatutoryVersion(version, {
    ...options,
    ...(existing ? { existing } : {}),
  } as Parameters<typeof publishStatutoryVersion>[1]);

describe("publishStatutoryVersion same-date guard (PAYR-02)", () => {
  it("refuses to publish when a published sibling of the same type has the same effectiveFrom", () => {
    const draft = draftOf(thrBase, DATE);
    const sibling = publishedOf(thrBase, DATE);
    const error = thrown(() => publish(draft, [sibling]));
    expect(error).toBeInstanceOf(PayrollError);
    expect((error as PayrollError).code).toBe(
      "PAYROLL_STATUTORY_TABLE_AMBIGUOUS",
    );
  });

  it("publishes when the published sibling has a different effectiveFrom", () => {
    const draft = draftOf(thrBase, DATE);
    const result = publish(draft, [publishedOf(thrBase, OTHER_DATE)]);
    expect(result.status).toBe("published");
    expect(result.publishedBy).toBe(financeApprover);
    expect(result.publishedAt).toBe(AT);
  });

  it("publishes when the same-date sibling is a draft or archived", () => {
    const draft = draftOf(thrBase, DATE);
    const result = publish(draft, [
      draftOf(thrBase, DATE),
      draftOf(thrBase, DATE, "archived"),
    ]);
    expect(result.status).toBe("published");
  });

  it("publishes when the same-date published sibling is another table type", () => {
    const draft = draftOf(thrBase, DATE);
    const result = publish(draft, [publishedOf(jhtBase, DATE)]);
    expect(result.status).toBe("published");
  });

  it("ignores the version itself when it appears in `existing`", () => {
    const draft = draftOf(thrBase, DATE);
    // Same id, even if a stale copy of it is (wrongly) marked published.
    const itself = { ...draft, status: "published" as const };
    const result = publish(draft, [
      itself as Base,
      publishedOf(thrBase, OTHER_DATE),
    ]);
    expect(result.status).toBe("published");
    expect(result.id).toBe(draft.id);
  });

  it("still publishes without `existing` (optional argument)", () => {
    expect(publish(draftOf(thrBase, DATE)).status).toBe("published");
  });

  it("still refuses a backdated version first (existing behaviour)", () => {
    const draft = draftOf(thrBase, "2026-11-10" as BusinessDate);
    const error = thrown(() => publish(draft, []));
    expect((error as PayrollError).code).toBe(
      "PAYROLL_STATUTORY_TABLE_BACKDATED",
    );
  });

  it("resolveStatutoryTable stays AMBIGUOUS for two same-date published rows", () => {
    const rows = [publishedOf(thrBase, DATE), publishedOf(thrBase, DATE)];
    const error = thrown(() => resolveStatutoryTable(rows, "thr", DATE));
    expect(error).toBeInstanceOf(PayrollError);
    expect((error as PayrollError).code).toBe(
      "PAYROLL_STATUTORY_TABLE_AMBIGUOUS",
    );
  });
});
