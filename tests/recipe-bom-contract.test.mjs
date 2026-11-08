// Recipe/BOM auto-deduction contract tests (bead legend-db6).
// Acceptance criteria: INV-02 (recipe consumption, modifier rules, deduction
// records) and KDS-07 (remake/comp consume stock) at contract level.

import assert from "node:assert/strict";
import { test } from "node:test";
import * as events from "../packages/shared/src/events/index.ts";
import * as inventory from "../packages/shared/src/inventory/index.ts";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = {
  tenant: uuid(1),
  outlet: uuid(2),
  modifier: uuid(3),
  item: uuid(4),
  uom: uuid(5),
  other: uuid(6),
  user: uuid(7),
  location: uuid(8),
  menuItem: uuid(9),
  deduction: uuid(10),
};
const orderId = "01JG0000000000000000000001";

const rule = (over) => ({
  action: "add",
  targetComponentType: null,
  targetComponentId: null,
  componentType: "item",
  componentId: ids.item,
  quantity: "18.0000",
  uomId: ids.uom,
  wastePctBp: 0,
  ...over,
});

test("INV-02 modifier rule shape: add needs a component, remove a target, replace both", () => {
  const schema = inventory.modifierRecipeRuleInputSchema;
  assert.ok(schema.safeParse(rule({})).success);
  assert.ok(
    schema.safeParse(
      rule({
        action: "remove",
        targetComponentType: "item",
        targetComponentId: ids.other,
        componentType: null,
        componentId: null,
        quantity: null,
        uomId: null,
      }),
    ).success,
  );
  assert.ok(
    schema.safeParse(
      rule({
        action: "replace",
        targetComponentType: "item",
        targetComponentId: ids.other,
      }),
    ).success,
  );
  // Wrong shapes.
  assert.equal(
    schema.safeParse(
      rule({ targetComponentType: "item", targetComponentId: ids.other }),
    ).success,
    false,
    "add must not carry a target",
  );
  assert.equal(
    schema.safeParse(rule({ action: "replace" })).success,
    false,
    "replace needs a target",
  );
  assert.equal(
    schema.safeParse(
      rule({
        action: "remove",
        targetComponentType: "item",
        targetComponentId: ids.other,
      }),
    ).success,
    false,
    "remove must not carry a component",
  );
  assert.equal(
    schema.safeParse(rule({ quantity: "0.0000" })).success,
    false,
    "quantity must be positive",
  );
  assert.equal(
    schema.safeParse(rule({ wastePctBp: 10_000 })).success,
    false,
    "waste must be below 100%",
  );
  assert.equal(
    inventory.putModifierRecipeRulesInputSchema.safeParse({
      rules: Array.from({ length: 51 }, () => rule({})),
    }).success,
    false,
    "at most 50 rules",
  );
});

const deduction = (over = {}) => ({
  id: ids.deduction,
  tenantId: ids.tenant,
  outletId: ids.outlet,
  kind: "sale",
  status: "posted",
  mode: "real_time",
  sourceType: "order",
  sourceId: orderId,
  businessDate: "2026-11-08",
  costIdr: 4500,
  skipReason: null,
  reason: null,
  recordedBy: null,
  beneficiaryUserId: null,
  shiftId: null,
  createdAt: "2026-11-08T03:00:00.000Z",
  postedAt: "2026-11-08T03:00:00.000Z",
  lines: [
    {
      inventoryItemId: ids.item,
      locationId: ids.location,
      quantity: "18.0000",
      unitCostIdr: "250.0000",
      ledgerEntryId: "01JG0000000000000000000002",
    },
  ],
  ...over,
});

test("INV-02 recipe deduction record: kinds, statuses and skip reasons", () => {
  const schema = inventory.recipeDeductionSchema;
  assert.ok(schema.safeParse(deduction()).success);
  for (const kind of ["sale", "remake", "comp", "duty_meal"])
    assert.ok(schema.safeParse(deduction({ kind })).success, kind);
  assert.ok(
    schema.safeParse(
      deduction({
        status: "skipped",
        skipReason: "no_recipe",
        costIdr: null,
        postedAt: null,
        lines: [],
      }),
    ).success,
  );
  assert.equal(schema.safeParse(deduction({ kind: "waste" })).success, false);
  assert.equal(
    schema.safeParse(deduction({ skipReason: "other" })).success,
    false,
  );
  assert.equal(
    schema.safeParse(deduction({ costIdr: -1 })).success,
    false,
    "cost must not be negative",
  );
  assert.equal(
    schema.safeParse(deduction({ extra: true })).success,
    false,
    "strict object",
  );
});

test("INV-02 outlet deduction settings: null mode follows the tenant", () => {
  assert.ok(
    inventory.outletDeductionSettingsSchema.safeParse({
      tenantId: ids.tenant,
      outletId: ids.outlet,
      recipeDeductionMode: null,
      effectiveMode: "real_time",
      saleLocationId: null,
      updatedAt: null,
    }).success,
  );
  assert.ok(
    inventory.putOutletDeductionSettingsInputSchema.safeParse({
      recipeDeductionMode: "close_of_day",
      saleLocationId: ids.location,
    }).success,
  );
  assert.equal(
    inventory.putOutletDeductionSettingsInputSchema.safeParse({
      recipeDeductionMode: "weekly",
      saleLocationId: null,
    }).success,
    false,
  );
});

test("INV-02 duty meal input: bounded quantity, modifiers and idempotency key", () => {
  const input = {
    outletId: ids.outlet,
    employeeUserId: ids.user,
    shiftId: null,
    menuItemId: ids.menuItem,
    variantId: null,
    modifierIds: [ids.modifier],
    quantity: 1,
    note: null,
    idempotencyKey: "duty-meal-0001",
  };
  const schema = inventory.recordDutyMealInputSchema;
  assert.ok(schema.safeParse(input).success);
  assert.equal(schema.safeParse({ ...input, quantity: 0 }).success, false);
  assert.equal(schema.safeParse({ ...input, quantity: 21 }).success, false);
  assert.equal(
    schema.safeParse({ ...input, idempotencyKey: "short" }).success,
    false,
  );
  assert.equal(
    schema.safeParse({
      ...input,
      modifierIds: Array.from({ length: 21 }, () => ids.modifier),
    }).success,
    false,
  );
  assert.equal(
    schema.safeParse({ ...input, tenantId: ids.tenant }).success,
    false,
    "tenant never comes from the client (TEN-02)",
  );
});

const issuePayload = {
  issueId: ids.deduction,
  orderId,
  orderItemId: "01JG0000000000000000000003",
  outletId: ids.outlet,
  businessDate: "2026-11-08",
  type: "remake",
  reason: "quality",
  stationId: null,
  recordedBy: ids.user,
  menuItemId: ids.menuItem,
  variantId: null,
  modifierIds: [],
  quantity: 1,
  occurredAt: "2026-11-08T03:00:00.000Z",
};

test("KDS-07 order_issue.recorded: catalogued event with remake and comp payloads", () => {
  const entry = events.eventCatalogByName.get("order_issue.recorded");
  assert.ok(entry, "order_issue.recorded is in the event catalog");
  assert.equal(entry.aggregateType, "order_issue");
  assert.equal(entry.payloadSchemaRef, "order_issue.recorded.v1");

  const schema = inventory.orderIssueRecordedPayloadSchema;
  assert.ok(schema.safeParse(issuePayload).success);
  assert.ok(schema.safeParse({ ...issuePayload, type: "comp" }).success);
  assert.equal(
    schema.safeParse({ ...issuePayload, type: "void" }).success,
    false,
  );
  assert.equal(
    schema.safeParse({ ...issuePayload, quantity: 0 }).success,
    false,
  );
  assert.equal(
    inventory.orderIssueRecordedEvent.payloadSchema,
    schema,
    "event is bound to the payload schema",
  );
});

test("INV-02 recipe BOM endpoints are unique and under /api/inventory", () => {
  const keys = inventory.recipeBomEndpoints.map(
    (endpoint) => `${endpoint.method} ${endpoint.path}`,
  );
  assert.equal(new Set(keys).size, keys.length);
  for (const endpoint of inventory.recipeBomEndpoints)
    assert.ok(endpoint.path.startsWith("/api/inventory/"), endpoint.path);
});
