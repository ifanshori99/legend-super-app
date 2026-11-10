// Segment materialize job (legend-ts50): a segment with a broken definition is
// skipped, not failed, so the sweep still marks the day done. Only a thrown
// error counts as failed and keeps the day open for the next tick.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";

const refreshSegmentMembers = vi.hoisted(() => vi.fn());
const segmentIds = vi.hoisted(() => ({ value: [] as string[] }));

vi.mock("../db/index.ts", () => ({ db: {} }));
vi.mock("../services/segments.service.ts", () => ({ refreshSegmentMembers }));
// The first withTenant call lists segment ids; later calls refresh one segment.
vi.mock("../db/tenant.ts", () => ({
  withTenant: vi.fn(
    async (_db: unknown, _ctx: unknown, run: (tx: unknown) => unknown) =>
      run({
        select: () => ({
          from: () => ({
            orderBy: async () => segmentIds.value.map((id) => ({ id })),
          }),
        }),
      }),
  ),
}));

import {
  runSegmentMaterialize,
  runSegmentMaterializeSweep,
} from "../worker/segment-materialize.job.ts";

const context = { tenant: { tenantId: "tenant-a" } } as ScopedTenantContext;
// 03:00 Asia/Jakarta, after the 02:00 start.
const now = new Date("2026-11-10T03:00:00+07:00");

beforeEach(() => {
  refreshSegmentMembers.mockReset();
  segmentIds.value = ["s1", "s2", "s3"];
});

describe("TS50 segment materialize job", () => {
  it("counts a null result (broken definition) as skipped, a throw as failed", async () => {
    refreshSegmentMembers
      .mockResolvedValueOnce({ id: "s1" })
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("boom"));
    const result = await runSegmentMaterialize({} as never, context, now);
    expect(result).toMatchObject({
      segments: 3,
      refreshed: 1,
      skipped: 1,
      failed: 1,
    });
  });

  it("marks the day done with a skipped segment and retries after a failure", async () => {
    segmentIds.value = ["s1", "s2"];
    refreshSegmentMembers
      .mockResolvedValueOnce({ id: "s1" })
      .mockResolvedValueOnce(null);
    const first = await runSegmentMaterializeSweep(
      { tenant: { tenantId: "tenant-skip" } } as ScopedTenantContext,
      now,
    );
    expect(first).toMatchObject({ skipped: 1, failed: 0 });
    // Same day: no second run.
    expect(
      await runSegmentMaterializeSweep(
        { tenant: { tenantId: "tenant-skip" } } as ScopedTenantContext,
        now,
      ),
    ).toBeNull();

    refreshSegmentMembers.mockRejectedValue(new Error("boom"));
    const failing = {
      tenant: { tenantId: "tenant-fail" },
    } as ScopedTenantContext;
    expect(await runSegmentMaterializeSweep(failing, now)).toMatchObject({
      failed: 2,
    });
    expect(await runSegmentMaterializeSweep(failing, now)).not.toBeNull();
  });
});
