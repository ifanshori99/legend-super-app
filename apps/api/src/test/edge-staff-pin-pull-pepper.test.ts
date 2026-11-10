// Edge staff pin pull hands the page's peppers over BEFORE it applies records
// (beads legend-ideif, legend-jmsdx; PRD v1.7 §3 F6 "Staf — PIN Perangkat", EDG-02). A record
// hashed under a new pepper version must never land on the edge without the
// pepper that verifies it. The record applier is replaced by a spy that logs
// the order of events, so no database is needed here.
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";

const events = vi.hoisted(() => [] as string[]);

vi.mock("../services/staff-pin-sync.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/staff-pin-sync.ts")>()),
  applyStaffPinRecords: vi.fn(async () => {
    events.push("apply");
    return { applied: 0, skipped: 0 };
  }),
}));

import { pullStaffPins } from "../edge/staff-pin-pull.ts";

const context = {} as ScopedTenantContext;
const pepper = () => randomBytes(32).toString("base64");

const page = (peppers?: Array<{ version: number; pepper: string }>) => ({
  data: [],
  meta: {
    limit: 100,
    nextCursor: null,
    watermark: null,
    ...(peppers !== undefined ? { peppers } : {}),
  },
});

beforeEach(() => {
  events.length = 0;
});

describe("legend-jmsdx the edge pull stores peppers before applying records", () => {
  it("calls onPeppers with the page's peppers, then applies the page", async () => {
    const delivered = [
      { version: 2, pepper: pepper() },
      { version: 3, pepper: pepper() },
    ];
    const received: unknown[] = [];
    await pullStaffPins({
      context,
      since: null,
      fetchPage: async () => page(delivered),
      onPeppers: async (peppers) => {
        events.push("peppers");
        received.push(peppers);
      },
    });
    expect(events).toEqual(["peppers", "apply"]);
    expect(received).toEqual([delivered]);
  });

  it("does not call onPeppers when the page has no peppers or an empty list", async () => {
    const onPeppers = vi.fn(async () => {});
    for (const body of [page(), page([])])
      await pullStaffPins({
        context,
        since: null,
        fetchPage: async () => body,
        onPeppers,
      });
    expect(onPeppers).not.toHaveBeenCalled();
    expect(events).toEqual(["apply", "apply"]);
  });

  it("a page with peppers still pulls when no onPeppers is wired", async () => {
    const result = await pullStaffPins({
      context,
      since: null,
      fetchPage: async () => page([{ version: 2, pepper: pepper() }]),
    });
    expect(result.pages).toBe(1);
  });

  it("an onPeppers failure aborts the pull and applies nothing", async () => {
    const delivered = pepper();
    const error = await pullStaffPins({
      context,
      since: null,
      fetchPage: async () => page([{ version: 2, pepper: delivered }]),
      onPeppers: async () => {
        throw new Error("could not seal the peppers");
      },
    }).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toBe("could not seal the peppers");
    expect(events).toEqual([]);
  });

  it("a malformed pepper is refused as an unknown page shape, without quoting it", async () => {
    const error = await pullStaffPins({
      context,
      since: null,
      fetchPage: async () => page([{ version: 2, pepper: "too-short-pepper" }]),
      onPeppers: async () => {
        events.push("peppers");
      },
    }).catch((caught: unknown) => caught as Error);
    expect(String((error as Error).message)).not.toContain("too-short-pepper");
    expect(events).toEqual([]);
  });

  it("a version 1 pepper is refused as an unknown page shape (an edge never gets one)", async () => {
    const error = await pullStaffPins({
      context,
      since: null,
      fetchPage: async () => page([{ version: 1, pepper: pepper() }]),
      onPeppers: async () => {
        events.push("peppers");
      },
    }).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect(events).toEqual([]);
  });
});
