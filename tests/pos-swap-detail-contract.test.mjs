// legend-kxoyf: posOrderDetailSchema after a kitchen swap on a POS order.
// The swap leaves orders.subtotal_idr/total_idr frozen while the live lines
// change, so the detail declares two amounts that balance the subtotal check:
//   swapReplacementIdr = sum of counted replacement lines,
//   swapReplacedIdr    = sum of voided swapped-out lines,
//   subtotalIdr == sum(counted lines) - swapReplacementIdr + swapReplacedIdr.
//
// Assumptions where the brief is silent:
// - The draft fixture order (orderDetails[2]) stands for an open order: its
//   first line is swapped out (voided), a replacement line is added.
// - The completed fixture order (orderDetails[0]) stands for a completed order:
//   the old line stays live (swapRole "replaced"), only the replacement line
//   (swapRole "replacement", unit price 0) is added.
// - Both fields are optional on input and default to 0.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as pos from "../packages/shared/src/pos/index.ts";

const parsed = pos.posFixtureSchema.parse(pos.cafeLegendPosFixtures);
const schema = pos.posOrderDetailSchema;

const open = parsed.orderDetails[2]; // draft: 44.000 + 26.000 live, 32.000 voided
const completed = parsed.orderDetails[0]; // completed: 64.000 + 20.000 + 20.000
const voidedLine = open.items.find((item) => item.status === "voided");
assert.ok(voidedLine, "fixture has a voided line to copy void metadata from");

/**
 * Open order: the first line is swapped out and voided (swapRole "replaced",
 * no POS-02 approval chain: the recovery flow approved it); a replacement line
 * (swapRole "replacement") is added.
 */
function openSwap(replacementLineTotalIdr) {
  const [first, ...rest] = open.items;
  const swappedOut = {
    ...first,
    swapRole: "replaced",
    status: "voided",
    voidReason: "other",
    voidReasonNote: "Item gagal ditukar di dapur",
    voidedBy: null,
    voidApprovedBy: null,
    voidApprovalRequestId: null,
    voidOverrideId: null,
  };
  const replacement = {
    ...first,
    id: "01JBQ9C0000000000000000099",
    swapRole: "replacement",
    unitPriceIdr: replacementLineTotalIdr / first.quantity,
    lineTotalIdr: replacementLineTotalIdr,
  };
  return {
    swappedOut,
    replacement,
    order: {
      ...open,
      items: [swappedOut, ...rest, replacement],
      swapReplacementIdr: replacementLineTotalIdr,
      swapReplacedIdr: first.lineTotalIdr,
    },
  };
}

/**
 * Completed order: the swapped-out line stays live (swapRole "replaced", not
 * voided, so swapReplacedIdr is 0) and the replacement line is recorded at
 * unit price 0 (the customer already paid the final order).
 */
function completedSwap(replacementUnitPriceIdr = 0) {
  const source = completed.items[1];
  const replacement = {
    ...source,
    id: "01JBQ9C0000000000000000098",
    swapRole: "replacement",
    unitPriceIdr: replacementUnitPriceIdr,
    lineTotalIdr: replacementUnitPriceIdr * source.quantity,
  };
  const replacementTotal = replacement.lineTotalIdr;
  return {
    replacement,
    order: {
      ...completed,
      items: [
        completed.items[0],
        { ...source, swapRole: "replaced" },
        ...completed.items.slice(2),
        replacement,
      ],
      swapReplacementIdr: replacementTotal,
      swapReplacedIdr: 0,
    },
  };
}

const issuePaths = (result) =>
  result.error.issues.map((issue) => issue.path.join("."));

test("legend-kxoyf order without a swap: swap fields default to 0 and the subtotal must match the lines", () => {
  for (const order of parsed.orderDetails) {
    const result = schema.parse(order);
    assert.equal(result.swapReplacementIdr, 0);
    assert.equal(result.swapReplacedIdr, 0);
  }
  const wrongSubtotal = schema.safeParse({
    ...open,
    subtotalIdr: open.subtotalIdr + 1,
  });
  assert.equal(wrongSubtotal.success, false);
  assert.ok(issuePaths(wrongSubtotal).includes("subtotalIdr"));
});

test("legend-kxoyf open order: a swap with a pricier, cheaper or same-price replacement keeps the frozen subtotal valid", () => {
  const swappedOutTotal = open.items[0].lineTotalIdr; // 44.000
  for (const replacementTotal of [
    swappedOutTotal + 6_000,
    swappedOutTotal - 4_000,
    swappedOutTotal,
  ]) {
    const { order } = openSwap(replacementTotal);
    assert.equal(order.subtotalIdr, open.subtotalIdr, "money stays frozen");
    const result = schema.safeParse(order);
    assert.equal(
      result.success,
      true,
      `replacement ${replacementTotal}: ${JSON.stringify(result.error?.issues)}`,
    );
  }
});

test("legend-kxoyf completed order: the old line stays live and a free replacement line keeps the frozen subtotal valid", () => {
  const { order } = completedSwap(0);
  assert.equal(order.subtotalIdr, completed.subtotalIdr, "money stays frozen");
  const result = schema.safeParse(order);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  // A priced replacement on a completed order is balanced by swapReplacementIdr too.
  for (const unitPrice of [20_000, 30_000]) {
    const priced = completedSwap(unitPrice);
    const pricedResult = schema.safeParse(priced.order);
    assert.equal(
      pricedResult.success,
      true,
      `unit price ${unitPrice}: ${JSON.stringify(pricedResult.error?.issues)}`,
    );
  }
});

test("legend-kxoyf swapRole: unit price 0 is allowed only on a replacement line", () => {
  const { order, replacement } = completedSwap(0);
  const index = order.items.findIndex((item) => item.id === replacement.id);
  for (const role of ["none", "replaced"]) {
    const result = schema.safeParse({
      ...order,
      items: order.items.map((item, i) =>
        i === index ? { ...item, swapRole: role } : item,
      ),
    });
    assert.equal(result.success, false, `swapRole ${role} at unit price 0`);
    assert.ok(issuePaths(result).includes(`items.${index}.unitPriceIdr`));
  }
  // A plain (non-swap) line at unit price 0 is still rejected.
  const plain = schema.safeParse({
    ...completed,
    items: completed.items.map((item, i) =>
      i === 0
        ? { ...item, unitPriceIdr: 0, modifiersTotalIdr: 0, lineTotalIdr: 0 }
        : item,
    ),
  });
  assert.equal(plain.success, false);
  assert.ok(issuePaths(plain).includes("items.0.unitPriceIdr"));
  // swapRole defaults to "none" on input.
  assert.equal(schema.parse(open).items[0].swapRole, "none");
});

test("legend-kxoyf swapRole: a replaced line needs no approval chain but a plain voided line still does", () => {
  const { swappedOut, order } = openSwap(50_000);
  assert.equal(swappedOut.voidedBy, null);
  assert.equal(swappedOut.voidApprovedBy, null);
  assert.equal(schema.safeParse(order).success, true);

  // The same voided line as a plain void (no swap role, no approval): rejected.
  const plainVoid = schema.safeParse({
    ...order,
    items: order.items.map((item) =>
      item.id === swappedOut.id ? { ...item, swapRole: "none" } : item,
    ),
  });
  assert.equal(plainVoid.success, false);
  assert.ok(issuePaths(plainVoid).includes("items.0.voidReason"));

  // A replaced line still needs a standard void reason.
  const noReason = schema.safeParse({
    ...order,
    items: order.items.map((item) =>
      item.id === swappedOut.id ? { ...item, voidReason: null } : item,
    ),
  });
  assert.equal(noReason.success, false);
  assert.ok(issuePaths(noReason).includes("items.0.voidReason"));
});

test("legend-kxoyf an extra replacement line without declaring the swap is rejected", () => {
  const { order } = openSwap(50_000);
  const undeclared = schema.safeParse({
    ...order,
    swapReplacementIdr: 0,
    swapReplacedIdr: 0,
  });
  assert.equal(undeclared.success, false);
  assert.ok(issuePaths(undeclared).includes("subtotalIdr"));

  const { order: completedOrder } = completedSwap(30_000);
  assert.equal(
    schema.safeParse({
      ...completedOrder,
      swapReplacementIdr: 0,
      swapReplacedIdr: 0,
    }).success,
    false,
  );
});

test("legend-kxoyf declared swap amounts that do not balance the subtotal are rejected", () => {
  const { order } = openSwap(50_000);
  assert.equal(
    schema.safeParse({ ...order, swapReplacementIdr: 49_999 }).success,
    false,
    "replacement amount off by one",
  );
  assert.equal(
    schema.safeParse({ ...order, swapReplacedIdr: order.swapReplacedIdr - 1 })
      .success,
    false,
    "replaced amount off by one",
  );
  // The declared swap does not rescue a wrong subtotal.
  const wrongSubtotal = schema.safeParse({
    ...order,
    subtotalIdr: order.subtotalIdr + 1,
  });
  assert.equal(wrongSubtotal.success, false);
  assert.ok(issuePaths(wrongSubtotal).includes("subtotalIdr"));
});

test("legend-kxoyf swap amounts must equal the swapRole line sums", () => {
  // swapReplacementIdr set while no line has swapRole "replacement".
  const noReplacementLine = schema.safeParse({
    ...open,
    swapReplacementIdr: 1_000,
    subtotalIdr: open.subtotalIdr - 1_000, // balanced, so only the equality fails
  });
  assert.equal(noReplacementLine.success, false);
  assert.ok(issuePaths(noReplacementLine).includes("swapReplacementIdr"));

  // swapReplacedIdr set while no voided line has swapRole "replaced".
  const noReplacedLine = schema.safeParse({
    ...open,
    swapReplacedIdr: 1_000,
    subtotalIdr: open.subtotalIdr + 1_000,
  });
  assert.equal(noReplacedLine.success, false);
  assert.ok(issuePaths(noReplacedLine).includes("swapReplacedIdr"));

  // A real swap with the amounts off by one (subtotal kept balanced) is rejected.
  const { order } = openSwap(50_000);
  const replacementOff = schema.safeParse({
    ...order,
    swapReplacementIdr: order.swapReplacementIdr + 1,
    subtotalIdr: order.subtotalIdr - 1,
  });
  assert.equal(replacementOff.success, false);
  assert.ok(issuePaths(replacementOff).includes("swapReplacementIdr"));
  const replacedOff = schema.safeParse({
    ...order,
    swapReplacedIdr: order.swapReplacedIdr + 1,
    subtotalIdr: order.subtotalIdr + 1,
  });
  assert.equal(replacedOff.success, false);
  assert.ok(issuePaths(replacedOff).includes("swapReplacedIdr"));

  // A replaced line that stays live (completed order) counts in neither sum:
  // declaring its total as swapReplacedIdr is rejected.
  const { order: completedOrder } = completedSwap(0);
  const liveReplaced = schema.safeParse({
    ...completedOrder,
    swapReplacedIdr: 20_000,
    subtotalIdr: completedOrder.subtotalIdr + 20_000,
  });
  assert.equal(liveReplaced.success, false);
  assert.ok(issuePaths(liveReplaced).includes("swapReplacedIdr"));

  // A voided order carries no adjustment: it counts every line.
  const voidedOrder = parsed.orderDetails.find((o) => o.status === "voided");
  assert.ok(voidedOrder, "fixture has a voided order");
  assert.equal(schema.safeParse(voidedOrder).success, true);
  assert.equal(
    schema.safeParse({ ...voidedOrder, swapReplacedIdr: 1_000 }).success,
    false,
  );
  assert.equal(
    schema.safeParse({ ...voidedOrder, swapReplacementIdr: 1_000 }).success,
    false,
  );
});

test("legend-kxoyf abuse: a cashier-voided line cannot be passed off as a swapped-out line to hide a wrong subtotal", () => {
  const cashierVoided = open.items.find((item) => item.status === "voided");
  assert.equal(cashierVoided.swapRole, "none");
  assert.equal(
    open.items.filter((item) => item.swapRole !== "none").length,
    0,
    "the order has no swap lines",
  );
  const abuse = schema.safeParse({
    ...open,
    subtotalIdr: open.subtotalIdr + cashierVoided.lineTotalIdr,
    swapReplacedIdr: cashierVoided.lineTotalIdr,
  });
  assert.equal(abuse.success, false);
  assert.ok(issuePaths(abuse).includes("swapReplacedIdr"));
});

test("legend-kxoyf negative swap amounts are rejected", () => {
  assert.equal(
    schema.safeParse({ ...open, swapReplacementIdr: -1 }).success,
    false,
  );
  assert.equal(
    schema.safeParse({ ...open, swapReplacedIdr: -1 }).success,
    false,
  );
});
