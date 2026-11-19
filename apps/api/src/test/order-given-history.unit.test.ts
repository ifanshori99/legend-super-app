// Pure unit tests for allocateRefundRowIdr (bead 1169). No database.
import { describe, expect, it } from "vitest";
import { allocateRefundRowIdr } from "../services/order-given-history";

const w = (entries: [string, bigint][]) => new Map(entries);
const sum = (m: Map<string, number>) =>
  [...m.values()].reduce((a, b) => a + b, 0);
const open = () => Number.MAX_SAFE_INTEGER;

describe("allocateRefundRowIdr", () => {
  it("returns an empty map for amount <= 0 or no lines", () => {
    expect(allocateRefundRowIdr(0, w([["a", 1n]]), open).size).toBe(0);
    expect(allocateRefundRowIdr(-5, w([["a", 1n]]), open).size).toBe(0);
    expect(allocateRefundRowIdr(10, w([]), open).size).toBe(0);
  });

  it("splits by weight with largest remainder and keeps the sum", () => {
    const r = allocateRefundRowIdr(
      34651,
      w([
        ["A", 10000n],
        ["B", 20001n],
      ]),
      open,
    );
    expect(sum(r)).toBe(34651);
    expect(r.get("A")).toBe(11550);
    expect(r.get("B")).toBe(23101);
  });

  it("is independent of the weights map insertion order", () => {
    const a = allocateRefundRowIdr(
      100,
      w([
        ["A", 1n],
        ["B", 1n],
        ["C", 1n],
      ]),
      open,
    );
    const b = allocateRefundRowIdr(
      100,
      w([
        ["C", 1n],
        ["A", 1n],
        ["B", 1n],
      ]),
      open,
    );
    expect([...a.entries()]).toEqual([...b.entries()]);
    // tie-break by id ascending: the extra rupiah goes to A.
    expect(a.get("A")).toBe(34);
    expect(a.get("B")).toBe(33);
    expect(a.get("C")).toBe(33);
  });

  it("keeps the sum for many amounts and weights", () => {
    for (let amount = 1; amount <= 200; amount += 7) {
      const r = allocateRefundRowIdr(
        amount,
        w([
          ["a", 3n],
          ["b", 7n],
          ["c", 11n],
          ["d", 0n],
        ]),
        open,
      );
      expect(sum(r)).toBe(amount);
      expect(r.get("d")).toBe(0);
    }
  });

  it("uses equal weights when all weights are zero", () => {
    const r = allocateRefundRowIdr(
      7,
      w([
        ["a", 0n],
        ["b", 0n],
        ["c", 0n],
      ]),
      open,
    );
    expect(r.get("a")).toBe(3);
    expect(r.get("b")).toBe(2);
    expect(r.get("c")).toBe(2);
  });

  it("clamps to room and moves the leftover to lines with room, id ascending", () => {
    const rooms: Record<string, number> = { a: 10, b: 100, c: 100 };
    const r = allocateRefundRowIdr(
      90,
      w([
        ["a", 1n],
        ["b", 1n],
        ["c", 1n],
      ]),
      (id) => rooms[id]!,
    );
    // shares 30/30/30, a clamped to 10, leftover 20 to b.
    expect(r.get("a")).toBe(10);
    expect(r.get("b")).toBe(50);
    expect(r.get("c")).toBe(30);
    expect(sum(r)).toBe(90);
  });

  it("treats negative room as zero", () => {
    const rooms: Record<string, number> = { a: -5, b: 100 };
    const r = allocateRefundRowIdr(
      10,
      w([
        ["a", 1n],
        ["b", 1n],
      ]),
      (id) => rooms[id]!,
    );
    expect(r.get("a")).toBe(0);
    expect(r.get("b")).toBe(10);
  });

  it("puts the final residual on the heaviest line (tie: lower id) when every line is full", () => {
    const r = allocateRefundRowIdr(
      50,
      w([
        ["a", 1n],
        ["b", 5n],
        ["c", 5n],
      ]),
      () => 0,
    );
    expect(r.get("a")).toBe(0);
    expect(r.get("b")).toBe(50);
    expect(r.get("c")).toBe(0);
  });

  it("residual only covers what room cannot absorb", () => {
    const rooms: Record<string, number> = { a: 5, b: 5 };
    const r = allocateRefundRowIdr(
      30,
      w([
        ["a", 1n],
        ["b", 3n],
      ]),
      (id) => rooms[id]!,
    );
    // both filled to room (5 + 5), residual 20 to heaviest b.
    expect(r.get("a")).toBe(5);
    expect(r.get("b")).toBe(25);
    expect(sum(r)).toBe(30);
  });

  it("handles weights beyond Number precision", () => {
    const big = 10n ** 30n;
    const r = allocateRefundRowIdr(
      10,
      w([
        ["a", big],
        ["b", big * 2n],
      ]),
      open,
    );
    expect(r.get("a")).toBe(3);
    expect(r.get("b")).toBe(7);
  });
});
