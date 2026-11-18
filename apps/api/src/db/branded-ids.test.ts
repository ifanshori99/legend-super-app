import { describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { PgDialect, pgTable, uuid } from "drizzle-orm/pg-core";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import { outletIdColumn, tenantIdColumn } from "./columns.ts";
import { eqId, inArrayIds } from "./branded-ids.ts";

// Type-only helpers: no DB needed, compare the SQL text and params only.
const tenants = pgTable("branded_ids_tenants", {
  id: uuid("id").primaryKey(),
});
const outlets = pgTable("branded_ids_outlets", {
  id: uuid("id").primaryKey(),
});
const fixture = pgTable("branded_ids_fixture", {
  tenantId: tenantIdColumn(() => tenants.id).notNull(),
  outletId: outletIdColumn(() => outlets.id).notNull(),
});

const dialect = new PgDialect();
const tenantA = tenantIdSchema.parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const tenantB = tenantIdSchema.parse("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
const outletA = outletIdSchema.parse("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const outletB = outletIdSchema.parse("dddddddd-dddd-4ddd-8ddd-dddddddddddd");

describe("branded ID helpers emit the same SQL as plain drizzle", () => {
  it("eqId matches eq on a tenant ID column", () => {
    const plain = dialect.sqlToQuery(eq(fixture.tenantId, tenantA));
    const helper = dialect.sqlToQuery(eqId(fixture.tenantId, tenantA));
    expect(helper.sql).toBe(plain.sql);
    expect(helper.params).toEqual(plain.params);
    expect(helper.params).toEqual([tenantA]);
  });

  it("eqId matches eq on an outlet ID column", () => {
    const plain = dialect.sqlToQuery(eq(fixture.outletId, outletA));
    const helper = dialect.sqlToQuery(eqId(fixture.outletId, outletA));
    expect(helper.sql).toBe(plain.sql);
    expect(helper.params).toEqual(plain.params);
    expect(helper.params).toEqual([outletA]);
  });

  it("eqId accepts a loose string and binds it unchanged", () => {
    const loose: string = outletA;
    const helper = dialect.sqlToQuery(eqId(fixture.outletId, loose));
    expect(helper.sql).toBe(
      dialect.sqlToQuery(eq(fixture.outletId, outletA)).sql,
    );
    expect(helper.params).toEqual([outletA]);
  });

  it("inArrayIds matches inArray on a tenant ID column", () => {
    const plain = dialect.sqlToQuery(
      inArray(fixture.tenantId, [tenantA, tenantB]),
    );
    const helper = dialect.sqlToQuery(
      inArrayIds(fixture.tenantId, [tenantA, tenantB]),
    );
    expect(helper.sql).toBe(plain.sql);
    expect(helper.params).toEqual(plain.params);
    expect(helper.params).toEqual([tenantA, tenantB]);
  });

  it("inArrayIds matches inArray on an outlet ID column, loose strings", () => {
    const loose: readonly string[] = [outletA, outletB];
    const plain = dialect.sqlToQuery(
      inArray(fixture.outletId, [outletA, outletB]),
    );
    const helper = dialect.sqlToQuery(inArrayIds(fixture.outletId, loose));
    expect(helper.sql).toBe(plain.sql);
    expect(helper.params).toEqual(plain.params);
    expect(helper.params).toEqual([outletA, outletB]);
  });
});
