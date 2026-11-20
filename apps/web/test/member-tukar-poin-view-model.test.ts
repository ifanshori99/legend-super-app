// legend-0ne0z: what the points picker previews for a typed amount.
import {
  capPoints,
  formatIdr,
  formatPoints,
  previewRedeem,
} from "@/features/member-tukar-poin/view-model";

const quote = {
  balancePoints: 1_240,
  pointValueIdr: 100,
  minPoints: 1,
  maxPoints: 1_240,
  remainingIdr: 185_000,
  refusal: null,
} as const;

describe("member tukar poin preview", () => {
  it("500 poin: Rp50.000 off, Rp135.000 left, 740 poin left", () => {
    const preview = previewRedeem(quote, "500");
    expect(preview).toEqual({
      points: 500,
      valueIdr: 50_000,
      remainingAfterIdr: 135_000,
      balanceAfter: 740,
      error: null,
    });
    expect(formatIdr(preview.valueIdr)).toBe("Rp50.000");
    expect(formatIdr(preview.remainingAfterIdr)).toBe("Rp135.000");
  });

  it("740 poin leaves 500 poin", () => {
    expect(previewRedeem(quote, "740").balanceAfter).toBe(500);
  });

  it("more than the balance is over_balance", () => {
    const preview = previewRedeem(quote, "1500");
    expect(preview.error).toBe("over_balance");
    expect(preview.points).toBeNull();
  });

  it("0, empty and a decimal are rejected", () => {
    expect(previewRedeem(quote, "0").error).toBe("below_min");
    expect(previewRedeem(quote, "").error).toBe("empty");
    expect(previewRedeem(quote, "  ").error).toBe("empty");
    expect(previewRedeem(quote, "1,5").error).toBe("not_integer");
    expect(previewRedeem(quote, "1.5").error).toBe("not_integer");
    expect(previewRedeem(quote, "-5").error).toBe("not_integer");
  });

  it("a small bill caps the points: over_bill within the balance", () => {
    const small = { ...quote, remainingIdr: 5_000, maxPoints: 50 };
    expect(previewRedeem(small, "50").error).toBeNull();
    expect(previewRedeem(small, "51").error).toBe("over_bill");
    expect(previewRedeem(small, "1500").error).toBe("over_balance");
  });

  it("a bloated maxPoints is capped by the remaining bill", () => {
    const bloated = { ...quote, remainingIdr: 5_000, maxPoints: 1_240 };
    expect(capPoints(bloated)).toBe(50);
    expect(previewRedeem(bloated, "50").error).toBeNull();
    const over = previewRedeem(bloated, "51");
    expect(over.error).toBe("over_bill");
    expect(over.points).toBeNull();
  });

  it("a bloated maxPoints is capped by the balance", () => {
    const bloated = { ...quote, balancePoints: 300, maxPoints: 9_999 };
    expect(capPoints(bloated)).toBe(300);
    expect(previewRedeem(bloated, "301").error).toBe("over_balance");
  });

  it("a stale quote never yields a negative remaining bill", () => {
    const stale = { ...quote, remainingIdr: 0, maxPoints: 500 };
    expect(capPoints(stale)).toBe(0);
    expect(previewRedeem(stale, "10").error).toBe("over_bill");
    const odd = { ...quote, remainingIdr: 50, pointValueIdr: 100 };
    expect(previewRedeem(odd, "1").error).toBe("over_bill");
    expect(previewRedeem(odd, "1").remainingAfterIdr).toBe(50);
  });

  it("a non-positive point value caps at 0", () => {
    expect(capPoints({ ...quote, pointValueIdr: 0 })).toBe(0);
    expect(previewRedeem({ ...quote, pointValueIdr: 0 }, "1").error).toBe(
      "over_bill",
    );
  });

  it("a refused quote is not_eligible whatever is typed", () => {
    const refused = {
      ...quote,
      maxPoints: 0,
      refusal: "bill_settled",
    } as const;
    expect(previewRedeem(refused, "10").error).toBe("not_eligible");
  });

  it("formats whole rupiah and points the Indonesian way", () => {
    expect(formatIdr(185_000)).toBe("Rp185.000");
    expect(formatPoints(1_240)).toBe("1.240 poin");
  });
});
