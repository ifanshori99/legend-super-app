// O4 offline cashier UI (bead legend-wasr7.8, mockup design/mockups/pos/offline,
// Keputusan CTO O4). Components rendered on the server; the queue is the real
// O3 store over the in-memory backend.
//
// Assumptions (from the mockup and the decisions):
// - "Simpan penjualan" puts the sale in the tablet queue with its `L` number;
//   the change is received - total; a short cash amount saves nothing.
// - Offline only cash and manual EDC are choices; QRIS, VA/e-wallet, points,
//   voucher and DP are named as online only, never offered.
// - The shift close and the sign-out are refused while sales are queued, with
//   the count and the way on (queue, supervisor force close).
// - A parked sale shows as set aside with its conflict report explained.
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import {
  OFFLINE_KIT_TTL_MS,
  posOfflineKitSchema,
  type OfflineSaleEvent,
  type PosOfflineKit,
} from "@starter/shared/pos";
import { cafeLegendFixtures } from "@starter/shared/core";
import { cafeLegendTaxFixtures } from "@starter/shared/tax";
import { buttonsOf, rupiah, visibleText } from "./pos-payment-936-helpers";

// Radix dialogs portal to document.body; on the server they render inline.
vi.mock("@/components/ui/dialog", () => {
  const box =
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children);
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? createElement("div", { role: "dialog" }, children) : null,
    DialogContent: box("div"),
    DialogHeader: box("div"),
    DialogFooter: box("div"),
    DialogTitle: box("h2"),
    DialogDescription: box("p"),
  };
});

// The router is not mounted in server rendering: Link is a plain anchor.
vi.mock("@tanstack/react-router", () => ({
  useRouteContext: () => ({
    access: { permissions: ["shift.cash.approve_close"] },
  }),
  Link: ({ children }: { children?: ReactNode }) =>
    createElement("a", null, children),
}));

import { useT } from "@/components/i18n";
import { OfflineBanner } from "@/features/ws04-pos-kasir/offline/offline-banner";
import { OfflineCloseBlockBody } from "@/features/ws04-pos-kasir/offline/offline-close-block";
import { PayBody } from "@/features/ws04-pos-kasir/offline/offline-pay-dialog";
import { OfflineQueueBody } from "@/features/ws04-pos-kasir/offline/offline-queue-sheet";
import { createOfflineQueue } from "@/features/ws04-pos-kasir/offline/queue";
import {
  cashOf,
  saveOfflineSale,
  tenderOf,
} from "@/features/ws04-pos-kasir/offline/sale-view";
import { SignOutBlockedDialog } from "@/features/ws04-pos-kasir/offline/sign-out-blocked-dialog";
import { createMemoryOfflineBackend } from "@/features/ws04-pos-kasir/offline/store";

const OUTLET = cafeLegendFixtures.outlets[0].id;
const CATEGORY = "0a1b2c3d-0000-4000-8000-000000000c01";
const KOPI = "0a1b2c3d-0000-4000-8000-000000000101";

function kit(): PosOfflineKit {
  const issued = new Date();
  const catalog = {
    categories: [{ id: CATEGORY, name: "Minuman", sortOrder: 1 }],
    items: [
      {
        id: KOPI,
        categoryId: CATEGORY,
        categoryName: "Minuman",
        name: "Kopi Susu",
        basePriceIdr: 25_000,
        plainPriceIdr: 25_000,
        variants: [],
        imageUrl: null,
        course: null,
        code: null,
        soldOut: false,
        modifierGroups: [],
      },
    ],
    updatedAt: issued.toISOString(),
    source: "live",
  };
  return posOfflineKitSchema.parse({
    kitId: crypto.randomUUID(),
    outletId: OUTLET,
    deviceId: "0a1b2c3d-0000-4000-8000-0000000000d1",
    shiftId: "0a1b2c3d-0000-4000-8000-0000000000b1",
    issuedAt: issued.toISOString(),
    expiresAt: new Date(issued.getTime() + OFFLINE_KIT_TTL_MS).toISOString(),
    catalogVersion: "a".repeat(64),
    catalogs: { dine_in: catalog, takeaway: catalog },
    tax: {
      taxRules: cafeLegendTaxFixtures.taxRules.map((rule) => ({
        ...rule,
        regionCode: null,
      })),
      settings: cafeLegendTaxFixtures.settings,
      serviceChargeRules: [],
    },
    tenders: ["cash", "edc_card"],
    receiptRun: {
      sequenceId: "0a1b2c3d-0000-4000-8000-0000000000f1",
      prefix: "L1",
      lastNumber: 0,
      startedAt: issued.toISOString(),
    },
  });
}

const cart = {
  serviceType: "dine_in" as const,
  lines: [{ menuItemId: KOPI, variantId: null, quantity: 2, modifierIds: [] }],
};

function queueWith(theKit: PosOfflineKit) {
  const backend = createMemoryOfflineBackend();
  const queue = createOfflineQueue({
    backend,
    outletId: OUTLET,
    submit: async () => {
      throw new TypeError("Failed to fetch");
    },
    report: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  return { queue, ready: queue.saveKit(theKit) };
}

// useT outside a provider reads the full Indonesian catalog.
function T({
  children,
}: {
  children: (t: ReturnType<typeof useT>) => ReactNode;
}) {
  return children(useT());
}
const render = (body: (t: ReturnType<typeof useT>) => ReactNode) =>
  renderToString(createElement(T, null, body));

describe("offline sale", () => {
  test("Simpan penjualan queues the sale on the tablet with its L number", async () => {
    const theKit = kit();
    const { queue, ready } = queueWith(theKit);
    await ready;
    const event0 = await queue.pending();
    expect(event0).toHaveLength(0);
    // Pricing comes from the kit: read the total the dialog would show.
    const total = (
      await import("@/features/ws04-pos-kasir/offline/price")
    ).priceOfflineSale(theKit, cart, new Date()).totalIdr;
    const tender = tenderOf("cash", total, {
      receivedIdr: total + 10_000,
      reference: "",
    });
    expect(tender).not.toBeNull();
    const saved = await saveOfflineSale(queue, theKit, cart, tender!);
    expect(saved.receiptNumber).toBe("L1-000001");
    expect(saved.changeIdr).toBe(10_000);
    expect(await queue.pendingCount()).toBe(1);
    const [queued] = await queue.pending();
    expect(queued?.eventId).toBe(saved.event.eventId);
    expect(queued?.totalIdr).toBe(total);
    // A second sale takes the next number.
    const next = await saveOfflineSale(queue, theKit, cart, tender!);
    expect(next.receiptNumber).toBe("L1-000002");
  });

  test("short cash or an EDC sale without its slip number is no tender", () => {
    expect(
      tenderOf("cash", 50_000, { receivedIdr: 49_000, reference: "" }),
    ).toBeNull();
    expect(
      tenderOf("cash", 50_000, { receivedIdr: null, reference: "" }),
    ).toBeNull();
    expect(
      tenderOf("edc_card", 50_000, { receivedIdr: null, reference: "  " }),
    ).toBeNull();
    expect(
      tenderOf("edc_card", 50_000, { receivedIdr: null, reference: "004812" }),
    ).toEqual({ method: "edc_card", amountIdr: 50_000, reference: "004812" });
  });

  test("offline only cash and manual EDC are offered; online methods are not", () => {
    const theKit = kit();
    const { queue } = queueWith(theKit);
    const html = render((t) =>
      createElement(PayBody, {
        kit: theKit,
        cart,
        itemCount: 2,
        queue,
        onSaved: () => {},
        onCancel: () => {},
        t,
      }),
    );
    const radios = [...html.matchAll(/role="radio"[^>]*>(.*?)<\/button>/g)].map(
      (match) => visibleText(match[1]!).trim(),
    );
    expect(radios).toHaveLength(2);
    expect(radios[0]).toMatch(/^Tunai/);
    expect(radios[1]).toMatch(/^EDC manual/);
    const labels = buttonsOf(html).map((button) => button.label);
    for (const online of [/QRIS/i, /VA|virtual/i, /poin/i, /voucher/i, /DP/])
      expect(labels.some((label) => online.test(label))).toBe(false);
    const text = visibleText(html);
    expect(text).toContain("Hanya saat online");
    expect(text).toContain("harga daftar, tanpa promo");
    expect(text).toContain("Simpan penjualan");
  });
});

const sale = (
  sequenceNumber: number,
  totalIdr: number,
  tenders: OfflineSaleEvent["tenders"],
) =>
  ({
    eventId: `01JCQ8Z5N0M3X4Y5Z6A7B8C9D${sequenceNumber}`,
    sequenceNumber,
    paidAt: new Date(2026, 10, 27, 13, sequenceNumber).toISOString(),
    totalIdr,
    lines: [{ name: "Kopi Susu", quantity: 2 }],
    tenders,
  }) as unknown as OfflineSaleEvent;

describe("queue sheet", () => {
  const parked = sale(40, 71_600, [
    { method: "cash", amountIdr: 71_600, receivedIdr: 100_000 },
  ] as OfflineSaleEvent["tenders"]);
  const waiting = [
    sale(41, 48_000, [
      { method: "edc_card", amountIdr: 48_000, reference: "004812" },
    ] as OfflineSaleEvent["tenders"]),
    sale(42, 62_000, [
      { method: "cash", amountIdr: 62_000, receivedIdr: 62_000 },
    ] as OfflineSaleEvent["tenders"]),
  ];

  test("a parked sale shows as set aside with its conflict report", () => {
    const html = render((t) =>
      createElement(OfflineQueueBody, {
        rows: { waiting, parked: [parked] },
        failed: false,
        kit: kit(),
        online: true,
        syncing: false,
        syncFailed: false,
        onSync: () => {},
        t,
      }),
    );
    const text = visibleText(html);
    expect(text).toContain("Disisihkan · laporan dikirim");
    expect(text).toContain("Laporan konflik belum diterima cloud");
    expect(text).toContain("L1-000040");
    expect(text).toContain("EDC · slip 004812");
    expect(html.match(/data-parked="true"/g)).toHaveLength(1);
    expect(html.match(/Menunggu terkirim/g)!.length).toBeGreaterThanOrEqual(2);
    // Drawer cash still on the tablet: the two cash sales, not the EDC one.
    expect(cashOf([...waiting, parked])).toBe(133_600);
    expect(text).toContain(rupiah(133_600));
    // Nothing here deletes a sale.
    expect(buttonsOf(html).some((b) => /hapus/i.test(b.label))).toBe(false);
  });

  test("offline, sending now is not offered as a working action", () => {
    const html = render((t) =>
      createElement(OfflineQueueBody, {
        rows: { waiting, parked: [] },
        failed: false,
        kit: kit(),
        online: false,
        syncing: false,
        syncFailed: false,
        onSync: () => {},
        t,
      }),
    );
    const send = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)].find(
      (match) => visibleText(match[2]!).trim() === "Coba kirim sekarang",
    );
    expect(send?.[1]).toMatch(/aria-disabled="true"/);
  });
});

describe("refusals while sales are queued", () => {
  test("the shift close is refused with the count, the cash and the way on", () => {
    const html = render(() =>
      createElement(OfflineCloseBlockBody, {
        shiftId: "0a1b2c3d-0000-4000-8000-0000000000b1",
        pending: 3,
        parked: 1,
        cashIdr: 133_600,
        onOpenQueue: () => {},
      }),
    );
    const text = visibleText(html);
    expect(text).toContain("Shift belum bisa ditutup");
    expect(text).toContain("3 penjualan offline belum terkirim");
    expect(text).toContain("1 di antaranya disisihkan");
    expect(text).toContain(rupiah(133_600));
    expect(text).toMatch(/supervisor tutup paksa/i);
    expect(buttonsOf(html).map((b) => b.label)).toContain("Lihat antrean");
  });

  test("the sign-out is refused in a dialog while sales are queued", () => {
    const html = renderToString(
      createElement(SignOutBlockedDialog, {
        unsent: 3,
        onClose: () => {},
        onOpenCashier: () => {},
      }),
    );
    const text = visibleText(html);
    expect(text).toContain("Belum bisa keluar");
    expect(text).toContain("3 penjualan offline belum terkirim");
    expect(
      renderToString(
        createElement(SignOutBlockedDialog, {
          unsent: 0,
          onClose: () => {},
          onOpenCashier: () => {},
        }),
      ),
    ).toBe("");
  });

  test("the banner shows the queue count offline and the promo rule", () => {
    const html = render(() =>
      createElement(OfflineBanner, {
        state: { online: false, pending: 3, parked: 0, hasKit: true },
        onOpenQueue: () => {},
      }),
    );
    const text = visibleText(html);
    expect(text).toContain("Offline · 3 penjualan belum terkirim");
    expect(text).toContain("Promo tidak berlaku saat offline");
    const none = render(() =>
      createElement(OfflineBanner, {
        state: { online: true, pending: 0, parked: 0, hasKit: true },
        onOpenQueue: () => {},
      }),
    );
    expect(none).toBe("");
    const noKit = visibleText(
      render(() =>
        createElement(OfflineBanner, {
          state: { online: false, pending: 0, parked: 0, hasKit: false },
          onOpenQueue: () => {},
        }),
      ),
    );
    expect(noKit).toContain("penjualan offline tidak tersedia");
  });
});
