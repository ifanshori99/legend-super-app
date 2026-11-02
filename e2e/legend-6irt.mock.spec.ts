// Design v2 floor board (bead legend-6irt; owner Q25/Q27): a waiter call makes
// a tile urgent — solid StatusPill, 2px border and a 6px start rule — while
// occupied tiles sit on warm grey without a border. The status bar names the
// urgent action first ("Perlu tindakan") and the table code grows to 30/36.
// Runs against the mock web server (no API, no database):
// `LEGEND_MOCK_PORT=3240 pnpm test:e2e:mock e2e/legend-6irt.mock.spec.ts`.
import { expect, test, type Page } from "@playwright/test";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

async function openBoard(page: Page) {
  await page.goto("/pos/meja?mock=normal");
  await expect(
    page.getByRole("heading", { name: "Papan Status Meja" }),
  ).toBeVisible();
}

const tile = (page: Page, code: string) =>
  page.locator(`[data-table-code="${code}"]`);

const computed = (page: Page, code: string) =>
  tile(page, code).evaluate((node) => {
    const style = getComputedStyle(node);
    const tableCode = node.querySelector<HTMLElement>(
      '[data-slot="table-code"]',
    );
    return {
      background: style.backgroundColor,
      borderTop: style.borderTopWidth,
      borderTopStyle: style.borderTopStyle,
      borderStart: style.borderInlineStartWidth,
      borderStartColor: style.borderInlineStartColor,
      borderTopColor: style.borderTopColor,
      color: style.color,
      codeSize: tableCode ? getComputedStyle(tableCode).fontSize : null,
    };
  });

test("Q25 a waiter call makes the tile urgent: solid pill, 2px border, 6px start rule", async ({
  page,
}) => {
  await openBoard(page);
  const a03 = tile(page, "A03");
  await expect(a03).toHaveAttribute("data-board-status", "awaiting_order");
  await expect(a03).toHaveAttribute("data-urgent", "true");

  // The urgent state is the one solid pill: icon + text, never color alone.
  const pill = a03.locator('[data-slot="status-pill"][data-solid="true"]');
  await expect(pill).toContainText("1 panggilan waiter");

  const style = await computed(page, "A03");
  expect(style.borderStart).toBe("6px");
  expect(style.borderTop).toBe("2px");
  // The start rule and the border use the same (danger) status color.
  expect(style.borderStartColor).toBe(style.borderTopColor);
});

test("Q27 an occupied tile sits on warm grey with no border", async ({
  page,
}) => {
  await openBoard(page);
  const w02 = tile(page, "W02");
  await expect(w02).toHaveAttribute("data-tile-surface", "surface-3");
  const style = await computed(page, "W02");
  // surface-3 in the light palette is #f1efec.
  expect(style.background).toBe("rgb(241, 239, 236)");
  expect(style.borderTop).toBe("0px");
});

test("Q25 quiet states keep the surface hierarchy: empty card, cleaning dashed, inactive muted", async ({
  page,
}) => {
  await openBoard(page);

  const empty = await computed(page, "A01");
  expect(empty.background).toBe("rgb(255, 255, 255)");
  expect(empty.borderTop).not.toBe("0px");

  const cleaning = tile(page, "A04");
  await expect(cleaning).toHaveAttribute("data-dashed", "true");
  expect((await computed(page, "A04")).borderTopStyle).toBe("dashed");

  const inactive = tile(page, "W03");
  await expect(inactive).toHaveAttribute("data-tile-surface", "surface-2");
  await expect(inactive).toHaveAttribute("data-muted", "true");
  expect((await computed(page, "W03")).background).toBe("rgb(247, 246, 244)");

  // A requested bill is calm attention on the warm grey, not urgent.
  const bill = tile(page, "P1");
  await expect(bill).toHaveAttribute("data-calm", "true");
  await expect(bill).toHaveAttribute("data-tile-surface", "surface-3");
  await expect(bill).not.toHaveAttribute("data-urgent", "true");
});

test("the table code grows to 30/36 semibold (DESIGN v2 ops hierarchy)", async ({
  page,
}) => {
  await openBoard(page);
  expect((await computed(page, "A01")).codeSize).toBe("30px");
});

test("the status bar puts 'Perlu tindakan' first with the solid urgent count", async ({
  page,
}) => {
  await openBoard(page);
  const bar = page.locator('[data-slot="board-status-bar"]');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("Perlu tindakan");
  await expect(
    bar.locator('[data-slot="status-pill"][data-solid="true"]'),
  ).toContainText("1 meja perlu tindakan");
  // The legend below still carries every PRD board state with its count.
  for (const label of [
    "Kosong",
    "Terisi",
    "Menunggu pesanan",
    "Menunggu tagihan",
    "Perlu dibersihkan",
    "Direservasi",
  ])
    await expect(
      bar.getByRole("listitem").filter({ hasText: label }),
    ).toBeVisible();
});
