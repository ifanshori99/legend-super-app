// Pure recipe explosion tests (bead legend-db6; PRD v1.7 §3 F16 "Resep / BOM
// & Pemotongan Otomatis", acceptance INV-02). No database: `explodeRecipeTree`
// works on an in-memory recipe book.
//
// Assumptions (spec silent): a line's gross quantity is net / (1 - wastePct),
// rounded half_up to 4 decimals once per line (never per intermediate step);
// a nested recipe line is expressed in the nested recipe's yield unit; the
// maximum nesting depth is 10 (a chain of 15 must fail, a chain of 3 must not).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { explodeRecipeTree } from "../services/recipe-bom.service.ts";

type Line = {
  componentType: "item" | "recipe";
  componentId: string;
  quantity: string;
  uomId: string;
  wastePctBp: number;
};
type BookRecipe = {
  id: string;
  isActive: boolean;
  outputItemId: string | null;
  yieldQuantity: string;
  yieldUomId: string;
  lines: Line[];
};

const gram = randomUUID();
const milliliter = randomUUID();
const portion = randomUUID();

function recipe(
  lines: Line[],
  options: Partial<
    Pick<
      BookRecipe,
      "isActive" | "outputItemId" | "yieldQuantity" | "yieldUomId"
    >
  > = {},
): BookRecipe {
  return {
    id: randomUUID(),
    isActive: true,
    outputItemId: null,
    yieldQuantity: "1.0000",
    yieldUomId: portion,
    lines,
    ...options,
  };
}

const itemLine = (
  itemId: string,
  quantity: string,
  uomId = gram,
  wastePctBp = 0,
): Line => ({
  componentType: "item",
  componentId: itemId,
  quantity,
  uomId,
  wastePctBp,
});
const recipeLine = (
  recipeId: string,
  quantity: string,
  uomId: string,
  wastePctBp = 0,
): Line => ({
  componentType: "recipe",
  componentId: recipeId,
  quantity,
  uomId,
  wastePctBp,
});

function bookOf(...recipes: BookRecipe[]) {
  return { recipes: new Map(recipes.map((entry) => [entry.id, entry])) };
}

function explode(
  book: ReturnType<typeof bookOf>,
  root: string,
  multiplier = "1.0000",
) {
  return explodeRecipeTree(book as never, root, multiplier as never, []);
}

/** Sums the exploded components per item (the engine may or may not merge). */
function totals(outcome: ReturnType<typeof explode>): Record<string, string> {
  if (!outcome.ok) throw new Error(`explosion failed: ${outcome.reason}`);
  const sums = new Map<string, bigint>();
  for (const component of outcome.components) {
    const [whole = "0", fraction = ""] = component.quantity.split(".");
    const scaled =
      BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0").slice(0, 4));
    sums.set(component.itemId, (sums.get(component.itemId) ?? 0n) + scaled);
  }
  return Object.fromEntries(
    [...sums].map(([itemId, scaled]) => [
      itemId,
      `${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, "0")}`,
    ]),
  );
}

describe("INV-02 recipe explosion (pure)", () => {
  it("INV-02 grosses a line up by its waste percentage and scales by the multiplier", () => {
    const beans = randomUUID();
    // 18 g net with 10% waste is 20 g gross per cup; two cups draw 40 g.
    const menu = recipe([itemLine(beans, "18.0000", gram, 1000)]);
    expect(totals(explode(bookOf(menu), menu.id))).toEqual({
      [beans]: "20.0000",
    });
    expect(totals(explode(bookOf(menu), menu.id, "2.0000"))).toEqual({
      [beans]: "40.0000",
    });
  });

  it("INV-02 rounds half_up once per line, not once per step", () => {
    const sugar = randomUUID();
    // 1 / (1 - 0.3333) = 1.49992500...; times 3 is 4.49977500... => 4.4998.
    // Rounding the single-cup gross first (1.4999) would give 4.4997.
    const menu = recipe([itemLine(sugar, "1.0000", gram, 3333)]);
    expect(totals(explode(bookOf(menu), menu.id, "3.0000"))).toEqual({
      [sugar]: "4.4998",
    });
    // A tie rounds up: 0.0001 x 0.5 = 0.00005 => 0.0001.
    const tie = recipe([itemLine(sugar, "0.0001")]);
    expect(totals(explode(bookOf(tie), tie.id, "0.5000"))).toEqual({
      [sugar]: "0.0001",
    });
  });

  it("INV-02 explodes an inline sub-recipe by lineQty / yield and applies waste at every level", () => {
    const milk = randomUUID();
    const sugar = randomUUID();
    // Sub-recipe yields 2 portions from 400 ml milk + 100 g sugar.
    const sub = recipe(
      [itemLine(milk, "400.0000", milliliter), itemLine(sugar, "100.0000")],
      { yieldQuantity: "2.0000", yieldUomId: portion },
    );
    // The menu uses 1 portion (no waste on the recipe line) => half of the sub.
    const menu = recipe([recipeLine(sub.id, "1.0000", portion)]);
    expect(totals(explode(bookOf(menu, sub), menu.id))).toEqual({
      [milk]: "200.0000",
      [sugar]: "50.0000",
    });
    // 20% waste on the recipe line: 1 / 0.8 = 1.25 portions => 250 ml, 62.5 g.
    const wasteful = recipe([recipeLine(sub.id, "1.0000", portion, 2000)]);
    expect(totals(explode(bookOf(wasteful, sub), wasteful.id))).toEqual({
      [milk]: "250.0000",
      [sugar]: "62.5000",
    });
  });

  it("INV-02 draws a nested recipe's output item instead of exploding it", () => {
    const syrupItem = randomUUID();
    const sugar = randomUUID();
    const syrup = recipe([itemLine(sugar, "500.0000")], {
      outputItemId: syrupItem,
      yieldQuantity: "1000.0000",
      yieldUomId: milliliter,
    });
    const menu = recipe([recipeLine(syrup.id, "50.0000", milliliter, 2000)]);
    // 50 ml / 0.8 = 62.5 ml of the semi-finished item; sugar is not drawn.
    expect(totals(explode(bookOf(menu, syrup), menu.id))).toEqual({
      [syrupItem]: "62.5000",
    });
  });

  it("INV-02 rejects a cycle and a self reference as recipe_error", () => {
    const beans = randomUUID();
    const a = recipe([itemLine(beans, "1.0000")]);
    const b = recipe([recipeLine(a.id, "1.0000", portion)]);
    a.lines.push(recipeLine(b.id, "1.0000", portion));
    const cycle = explode(bookOf(a, b), a.id);
    expect(cycle).toMatchObject({ ok: false, reason: "recipe_error" });

    const self = recipe([itemLine(beans, "1.0000")]);
    self.lines.push(recipeLine(self.id, "1.0000", portion));
    expect(explode(bookOf(self), self.id)).toMatchObject({
      ok: false,
      reason: "recipe_error",
    });
  });

  it("INV-02 accepts a shallow chain and rejects one deeper than the limit", () => {
    const beans = randomUUID();
    function chain(length: number) {
      const recipes: BookRecipe[] = [];
      let previous = recipe([itemLine(beans, "1.0000")]);
      recipes.push(previous);
      for (let level = 1; level < length; level += 1) {
        previous = recipe([recipeLine(previous.id, "1.0000", portion)]);
        recipes.push(previous);
      }
      return { book: bookOf(...recipes), root: previous.id };
    }
    const shallow = chain(3);
    expect(totals(explode(shallow.book, shallow.root))).toEqual({
      [beans]: "1.0000",
    });
    const deep = chain(15);
    expect(explode(deep.book, deep.root)).toMatchObject({
      ok: false,
      reason: "recipe_error",
    });
  });

  it("INV-02 reports an inactive or unknown menu recipe instead of drawing stock", () => {
    const beans = randomUUID();
    const inactive = recipe([itemLine(beans, "1.0000")], { isActive: false });
    expect(explode(bookOf(inactive), inactive.id)).toMatchObject({
      ok: false,
      reason: "recipe_inactive",
    });
    expect(explode(bookOf(), randomUUID())).toMatchObject({
      ok: false,
      reason: "no_recipe",
    });
  });

  it("INV-02 rejects a recipe line whose unit differs from the nested recipe's yield unit", () => {
    const beans = randomUUID();
    const sub = recipe([itemLine(beans, "10.0000")], {
      yieldQuantity: "1.0000",
      yieldUomId: portion,
    });
    // The line says millilitres but the nested recipe yields portions.
    const menu = recipe([recipeLine(sub.id, "5.0000", milliliter)]);
    expect(explode(bookOf(menu, sub), menu.id)).toMatchObject({
      ok: false,
      reason: "recipe_error",
    });
  });

  it("draws the output item of a root recipe and of an add-on recipe instead of exploding lines", () => {
    const syrupItem = randomUUID();
    const shotItem = randomUUID();
    const sugar = randomUUID();
    const beans = randomUUID();
    const root = recipe([itemLine(sugar, "500.0000")], {
      outputItemId: syrupItem,
      yieldQuantity: "1000.0000",
      yieldUomId: milliliter,
    });
    expect(totals(explode(bookOf(root), root.id, "3.0000"))).toEqual({
      [syrupItem]: "3.0000",
    });
    const addOn = recipe([itemLine(beans, "18.0000")], {
      outputItemId: shotItem,
      yieldUomId: portion,
    });
    const menu = recipe([itemLine(sugar, "10.0000")]);
    const outcome = explodeRecipeTree(
      bookOf(menu, addOn) as never,
      menu.id,
      "2.0000" as never,
      [{ kind: "recipe", recipeId: addOn.id }],
    );
    expect(totals(outcome)).toEqual({
      [sugar]: "20.0000",
      [shotItem]: "2.0000",
    });
  });

  it("applies a replace rule only when its target line is in the base recipe", () => {
    const milk = randomUUID();
    const oat = randomUUID();
    const sugar = randomUUID();
    const replace = {
      kind: "replace" as const,
      target: { componentType: "item" as const, componentId: milk },
      line: itemLine(oat, "200.0000"),
    } as never;
    const withMilk = recipe([itemLine(milk, "200.0000")]);
    expect(
      totals(
        explodeRecipeTree(
          bookOf(withMilk) as never,
          withMilk.id,
          "1.0000" as never,
          [replace],
        ),
      ),
    ).toEqual({ [oat]: "200.0000" });
    const noMilk = recipe([itemLine(sugar, "10.0000")]);
    expect(
      totals(
        explodeRecipeTree(
          bookOf(noMilk) as never,
          noMilk.id,
          "1.0000" as never,
          [replace],
        ),
      ),
    ).toEqual({ [sugar]: "10.0000" });
  });
});
