// legend-tomda review (architect 1242, P2): a zero-price PO line is received
// only as an explicit supplier bonus. The form sends `isBonus` for a ticked
// zero-price line only, and the API's two refusals have their own message.
import {
  bonusFlagOf,
  isZeroPriceLine,
  receivingErrorKey,
} from "@/features/ws06-purchasing/receiving-lib";

const zero = { unitPriceIdr: "0.0000" };
const priced = { unitPriceIdr: "6000.0000" };

describe("tomda receipt bonus line", () => {
  it("only a zero-price line is a bonus candidate", () => {
    expect(isZeroPriceLine(zero)).toBe(true);
    expect(isZeroPriceLine(priced)).toBe(false);
  });

  it("isBonus is sent only for a ticked zero-price line", () => {
    expect(bonusFlagOf(zero, true)).toEqual({ isBonus: true });
    expect(bonusFlagOf(zero, false)).toEqual({});
    expect(bonusFlagOf(priced, true)).toEqual({});
  });

  it("both API refusals map to their own catalog text, not the generic one", () => {
    const required = receivingErrorKey("GOODS_RECEIPT_BONUS_REQUIRED");
    const pricedLine = receivingErrorKey("GOODS_RECEIPT_BONUS_PRICED_LINE");
    expect(required).toBe("inventoryReceiving.errors.bonusRequired");
    expect(pricedLine).toBe("inventoryReceiving.errors.bonusPricedLine");
    expect(required).not.toBe(receivingErrorKey("VALIDATION_ERROR"));
  });
});
