import { expect, test } from "@playwright/test";

// Station authorization on the KDS (bead legend-fsb7; PRD v1.7 §3 F7, §6 B).
//
// The board polls every station's queue for its switch counts (legend-haxq,
// 30 s per background station). A station-scoped account must never request a
// board outside its station reach — the API answers 403 — so the page filters
// the switch and the polls by the stations in the auth context. Mock mode
// derives that list from the role template (Barista / Cook = one station).
test("legend-fsb7 a station-scoped cook only sees its own station", async ({
  page,
  context,
}) => {
  await page.goto("/kds");
  await context.addCookies([
    {
      name: "legend-mock-role",
      value: "barista_cook",
      url: new URL(page.url()).origin,
    },
  ]);
  await page.reload();

  const stations = page.getByRole("radiogroup", { name: "Stasiun" });
  await expect(stations).toBeVisible({ timeout: 15_000 });
  // One station: no other board is shown or polled.
  await expect(stations.getByRole("radio")).toHaveCount(1);
  await expect(stations.getByRole("radio", { name: /^Kopi/ })).toBeVisible();
  await expect(stations.getByRole("radio", { name: /^Dapur/ })).toHaveCount(0);
});

test("legend-fsb7 a wildcard role still sees every station", async ({
  page,
}) => {
  await page.goto("/kds");
  const stations = page.getByRole("radiogroup", { name: "Stasiun" });
  await expect(stations).toBeVisible({ timeout: 15_000 });
  await expect(stations.getByRole("radio")).toHaveCount(4);
});
