// legend-wpqs: the legal entity of the first payroll policy / THR schedule comes
// from the organisation's own list (GET /api/org/legal-entities), not from an
// existing policy. A tenant with no policy yet must still be able to create one.
//
// Contract chosen for the web layer (the brief names no identifiers):
//  - features/ws10-payroll-config/api.ts exports `fetchPayrollLegalEntities()`,
//    one typed caller of the org `listLegalEntities` endpoint.
//  - features/ws10-payroll-config/hooks.ts exports `usePayrollLegalEntities`.
// The mock serves the org list and accepts a policy / THR schedule created for
// an entity of that list while the policy list is empty. The legal entity stays
// required (400 without it).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, test } from "node:test";
import { registerWebAlias } from "./helpers/web-alias.mjs";

// These features import through the web `@/` alias: register it first.
registerWebAlias();
const { dispatchMock, resetMocks } =
  await import("../apps/web/src/lib/mock/runtime.ts");
await import("../apps/web/src/features/ws07-accounting/mock.ts");
await import("../apps/web/src/features/ws10-payroll-config/mock.ts");
// hooks.ts needs React; the exported names are checked in the source text.
const feature = (file) =>
  readFileSync(
    new URL(
      `../apps/web/src/features/ws10-payroll-config/${file}`,
      import.meta.url,
    ),
    "utf8",
  );

const request = (method, path, { query, body } = {}) =>
  dispatchMock({ method, path, query, body });
const key = () => `wpqs-${Math.random().toString(36).slice(2)}-abcdef`;

beforeEach(() => resetMocks());

describe("payroll legal entity source (legend-wpqs)", () => {
  test("the payroll feature exposes a caller and a hook for the organisation's legal entities", () => {
    assert.match(
      feature("api.ts"),
      /export (const|function) fetchPayrollLegalEntities\b/,
    );
    assert.match(
      feature("hooks.ts"),
      /export (const|function) usePayrollLegalEntities\b/,
    );
  });

  test("the org list has at least one entity with an id and a name", async () => {
    const list = (await request("GET", "/api/org/legal-entities")).data;
    assert.ok(Array.isArray(list) && list.length >= 1);
    for (const entity of list) {
      assert.ok(entity.id);
      assert.ok(entity.name);
    }
  });

  test("a first policy can be created for an entity of the org list", async () => {
    const entity = (await request("GET", "/api/org/legal-entities")).data[0];
    const seed = (await request("GET", "/api/hris/payroll/policies")).data[0];
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip server fields
    const { id, tenantId, isActive, createdAt, updatedAt, ...fields } = seed;
    const created = (
      await request("POST", "/api/hris/payroll/policies", {
        body: {
          ...fields,
          legalEntityId: entity.id,
          name: "Kebijakan pertama wpqs",
          idempotencyKey: key(),
        },
      })
    ).data;
    assert.equal(created.legalEntityId, entity.id);
    assert.equal(created.name, "Kebijakan pertama wpqs");
    const listed = (
      await request("GET", "/api/hris/payroll/policies", {
        query: { legalEntityId: entity.id },
      })
    ).data;
    assert.ok(listed.some((policy) => policy.id === created.id));
  });

  test("a first THR schedule can be created for an entity of the org list", async () => {
    const entity = (await request("GET", "/api/org/legal-entities")).data[0];
    const seed = (await request("GET", "/api/hris/payroll/thr-schedules"))
      .data[0];
    const body = {
      legalEntityId: entity.id,
      name: "THR Idul Fitri wpqs",
      holidayName: seed.holidayName,
      holidayDate: seed.holidayDate,
      tenureAsOfDate: seed.tenureAsOfDate,
      payDate: seed.payDate,
      employeeIds: seed.employeeIds,
      idempotencyKey: key(),
    };
    const created = (
      await request("POST", "/api/hris/payroll/thr-schedules", { body })
    ).data;
    assert.equal(created.legalEntityId, entity.id);
    assert.equal(created.name, "THR Idul Fitri wpqs");
  });

  test("the legal entity is required: a policy and a THR schedule without it are refused", async () => {
    const seed = (await request("GET", "/api/hris/payroll/policies")).data[0];
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip server fields
    const { id, tenantId, isActive, createdAt, updatedAt, ...fields } = seed;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the field under test
    const { legalEntityId, ...withoutEntity } = fields;
    await assert.rejects(
      request("POST", "/api/hris/payroll/policies", {
        body: {
          ...withoutEntity,
          name: "Tanpa badan usaha",
          idempotencyKey: key(),
        },
      }),
      (error) => error.status === 400 || error.status === 422,
    );
    const thr = (await request("GET", "/api/hris/payroll/thr-schedules"))
      .data[0];
    await assert.rejects(
      request("POST", "/api/hris/payroll/thr-schedules", {
        body: {
          name: "Tanpa badan usaha",
          holidayName: thr.holidayName,
          holidayDate: thr.holidayDate,
          tenureAsOfDate: thr.tenureAsOfDate,
          payDate: thr.payDate,
          employeeIds: thr.employeeIds,
          idempotencyKey: key(),
        },
      }),
      (error) => error.status === 400 || error.status === 422,
    );
  });
});
