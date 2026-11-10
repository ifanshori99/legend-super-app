// Outlet picker order (bead legend-dfvpq): pure unit test of compareOutlets,
// literal expectations so it does not depend on the database collation.

import { describe, expect, it } from "vitest";
import { compareOutlets } from "../services/me-outlets.service";

const outlet = (name: string, id: string) => ({ name, id });
const order = (rows: { name: string; id: string }[]) =>
  [...rows].sort(compareOutlets).map((row) => row.id);

describe("compareOutlets", () => {
  it("orders numbers inside names numerically", () => {
    expect(
      order([outlet("Outlet 10", "a"), outlet("Outlet 2", "b")]),
    ).toEqual(["b", "a"]);
  });

  it("lets the name beat the id", () => {
    // Name order (Alpha, Beta) is the reverse of id order (z, a).
    expect(order([outlet("Beta", "a"), outlet("Alpha", "z")])).toEqual([
      "z",
      "a",
    ]);
  });

  it("falls back to the id when names differ only by case", () => {
    expect(order([outlet("Outlet KPI", "b"), outlet("OUTLET kpi", "a")])).toEqual(
      ["a", "b"],
    );
    expect(order([outlet("outlet kpi", "a"), outlet("Outlet KPI", "b")])).toEqual(
      ["a", "b"],
    );
  });

  it("orders mixed-case names by letters, ignoring case", () => {
    // Plain code-point order would put "Outlet KPI lain" after "...jkt" too,
    // so also check a pair where upper case would otherwise win.
    expect(
      order([outlet("Outlet KPI lain", "a"), outlet("Outlet KPI jkt", "b")]),
    ).toEqual(["b", "a"]);
    expect(order([outlet("outlet b", "a"), outlet("Outlet A", "b")])).toEqual([
      "b",
      "a",
    ]);
  });
});
