// 1145: an ORD-09 amount over its line's room by 1 to 3 IDR is a rounding
// artifact and is filed as exactly the room; over by more, or on a line with
// no room, it is refused (`null`). Teh of the promo order: pro-rata 9.325 over
// the line share 9.324.
import { describe, expect, it } from "vitest";
import {
  LINE_ROUNDING_TRIM_IDR,
  trimToLineRoomIdr,
} from "../services/order-given.ts";

describe("1145 trimToLineRoomIdr", () => {
  it("fits: the amount itself", () => {
    expect(trimToLineRoomIdr(9_324, 9_324)).toBe(9_324);
    expect(trimToLineRoomIdr(5_000, 9_324)).toBe(5_000);
  });

  it("over by 1 to 3 IDR: exactly the room (teh 9.325 -> 9.324)", () => {
    expect(trimToLineRoomIdr(9_325, 9_324)).toBe(9_324);
    expect(trimToLineRoomIdr(9_327, 9_324)).toBe(9_324);
  });

  it("over by more than 3 IDR, or no room: refused", () => {
    expect(LINE_ROUNDING_TRIM_IDR).toBe(3);
    expect(trimToLineRoomIdr(9_328, 9_324)).toBeNull();
    expect(trimToLineRoomIdr(2, 0)).toBeNull();
  });
});
