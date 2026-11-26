// O4 review K fixes (bead legend-wasr7.8, docs/qa/1272-o4-review.md, Keputusan
// CTO 27 Nov). Components rendered on the server; the router's Link is a plain
// anchor so the target can be read.
//
// Assumptions (from the review):
// - P1: a cafe whose tablet holds an offline queue is never locked out. The
//   force close screen /pos/supervisor/shift/$shiftId is reachable from the
//   shift close refusal, from the server's OFFLINE_QUEUE_UNVERIFIED refusal,
//   and from every open shift on the day close screen.
// - P3: the supervisor may force close also when the cashier has not sent a
//   count (COUNT_NOT_SUBMITTED); a witness is never the counter or the
//   cashier, whatever the letter case of the ID.
vi.hoisted(() => {
  (globalThis as { __WEB_DEV_SERVER__?: boolean }).__WEB_DEV_SERVER__ = false;
});

import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { ApiError } from "@/lib/api/errors";
import { visibleText } from "./pos-payment-936-helpers";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    children?: ReactNode;
  }) =>
    createElement(
      "a",
      {
        ...rest,
        href: Object.entries(params ?? {}).reduce(
          (path, [key, value]) => path.replace(`$${key}`, value),
          to,
        ),
      },
      children,
    ),
}));

import {
  OfflineCloseBlockBody,
  OfflineUnverifiedNotice,
} from "@/features/ws04-pos-kasir/offline/offline-close-block";
import { OpenShiftLinks } from "@/features/ws04-pos-kasir/components/day-close/open-shift-links";
import {
  offersForceClose,
  thirdPersons,
} from "@/features/ws04-pos-kasir/shift-extra-logic";
import { isOfflineQueueUnverified } from "@/features/ws04-pos-kasir/shift-api";

const SHIFT = "0a1b2c3d-0000-4000-8000-0000000000b1";
const OTHER = "0a1b2c3d-0000-4000-8000-0000000000b2";

const links = (html: string) =>
  [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs)].map(
    (match) => ({ href: match[1], label: visibleText(match[2] ?? "").trim() }),
  );

describe("P1 the force close is reachable", () => {
  test("the shift close refusal links to the force close of this shift", () => {
    const html = renderToString(
      createElement(OfflineCloseBlockBody, {
        shiftId: SHIFT,
        pending: 2,
        parked: 0,
        cashIdr: null,
        onOpenQueue: () => {},
      }),
    );
    expect(links(html)).toContainEqual({
      href: `/pos/supervisor/shift/${SHIFT}`,
      label: "Tutup paksa oleh supervisor",
    });
  });

  test("the server's offline queue refusal is recognised and links there too", () => {
    expect(
      isOfflineQueueUnverified(
        new ApiError(409, "OFFLINE_QUEUE_UNVERIFIED", "x"),
      ),
    ).toBe(true);
    expect(
      isOfflineQueueUnverified(new ApiError(409, "OFFLINE_QUEUE_PENDING", "x")),
    ).toBe(false);
    const html = renderToString(
      createElement(OfflineUnverifiedNotice, { shiftId: SHIFT }),
    );
    expect(visibleText(html)).toMatch(/bekal offline/i);
    expect(links(html)).toContainEqual({
      href: `/pos/supervisor/shift/${SHIFT}`,
      label: "Tutup paksa oleh supervisor",
    });
  });

  test("every open shift on the day close screen links to its force close", () => {
    const html = renderToString(
      createElement(OpenShiftLinks, {
        shifts: [
          { id: SHIFT, shiftNo: "0a1b2c3d", openedAt: "2026-11-27T01:00:00Z" },
          { id: OTHER, shiftNo: "0a1b2c3e", openedAt: "2026-11-27T02:30:00Z" },
        ],
        timeZone: "Asia/Jakarta",
      }),
    );
    const found = links(html);
    expect(found.map((link) => link.href)).toEqual([
      `/pos/supervisor/shift/${SHIFT}`,
      `/pos/supervisor/shift/${OTHER}`,
    ]);
    expect(found[0]?.label).toContain("0a1b2c3d");
    expect(found[0]?.label).toContain("08.00");
    expect(
      renderToString(
        createElement(OpenShiftLinks, { shifts: [], timeZone: "Asia/Jakarta" }),
      ),
    ).toBe("");
  });
});

describe("P3 force close entry and witnesses", () => {
  test("the force close is offered when the review is not wired or not counted", () => {
    expect(offersForceClose(new ApiError(501, "CONTRACT_PENDING", "x"))).toBe(
      true,
    );
    expect(
      offersForceClose(new ApiError(409, "COUNT_NOT_SUBMITTED", "x")),
    ).toBe(true);
    expect(offersForceClose(new ApiError(404, "NOT_FOUND", "x"))).toBe(false);
    expect(offersForceClose(new TypeError("Failed to fetch"))).toBe(false);
    expect(offersForceClose(null)).toBe(false);
  });

  test("a witness is neither the counter nor the cashier, in any letter case", () => {
    const counter = "0A1B2C3D-0000-4000-8000-0000000000D1";
    const cashier = "0a1b2c3d-0000-4000-8000-0000000000e1";
    const options = [
      { userId: counter.toLowerCase(), name: "Supervisor Satu" },
      { userId: cashier.toUpperCase(), name: "Kasir" },
      {
        userId: "0a1b2c3d-0000-4000-8000-0000000000d2",
        name: "Supervisor Dua",
      },
    ];
    expect(thirdPersons(options, [counter, cashier])).toEqual([
      {
        userId: "0a1b2c3d-0000-4000-8000-0000000000d2",
        name: "Supervisor Dua",
      },
    ]);
  });
});
