// Shared helpers for the catalog down-sync tests (beads legend-24318, d0ipm,
// 0mus6; design docs/briefs/24318-design.md "Desain sync_txid"). Test-only.
//
// The cloud only serves rows whose `sync_txid` is below the oldest transaction
// that is still open (`pg_snapshot_xmin(pg_current_snapshot())`). A test that
// writes cloud rows and exports them straight away must therefore first wait
// until that boundary has passed its own writes: `settleCloud`.
import { CATALOG_PROTOCOL_VERSION } from "@starter/shared/edge";
import { expect, vi } from "vitest";
import type { Pool } from "pg";
import { decodeCursor, encodeCursor } from "@starter/shared/core";

/**
 * Waits until every transaction committed before this call is below the
 * cloud's "commit-safe" boundary. Polls (other test files may hold a short
 * transaction); fails only when the boundary never moves.
 */
export async function settleCloud(pool: Pool, timeoutMs = 30_000) {
  const { rows } = await pool.query("SELECT pg_current_xact_id()::text AS x");
  const mark = BigInt(rows[0].x as string);
  await vi.waitFor(
    async () => {
      const result = await pool.query(
        "SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS m",
      );
      expect(BigInt(result.rows[0].m as string) > mark).toBe(true);
    },
    { timeout: timeoutMs, interval: 25 },
  );
}

/** A cursor in the `cat2` shape: `["cat2", "<sync_txid digits>", ...keys]`. */
export const catCursor = (txid: number | bigint | string, ...keys: string[]) =>
  encodeCursor(["cat2", String(txid), ...keys]);

type Rec = Record<string, unknown>;
export type ScriptedPage = {
  protocolVersion: number;
  stream: string;
  records: Rec[];
  nextCursor: string | null;
  hasMore: boolean;
};

/**
 * A scripted cloud: serves `data[stream]` in pages of `pageSize` with `cat2`
 * cursors that carry the position (`catCursor(position, stream)`), so the
 * puller can store and decode them like real ones.
 */
export function scriptedCatalogCloud(
  data: Record<string, Rec[]>,
  pageSize: number,
) {
  const calls: { stream: string; since: string | null }[] = [];
  const seen: Record<string, number> = {};
  let broken: { stream: string; fromCall: number } | null = null;
  const positionOf = (since: string | null) => {
    if (since === null) return 0;
    return Number(decodeCursor(since)[1]);
  };
  const fetchPage = async (
    stream: string,
    since: string | null,
  ): Promise<ScriptedPage> => {
    calls.push({ stream, since });
    seen[stream] = (seen[stream] ?? 0) + 1;
    if (broken && broken.stream === stream && seen[stream]! >= broken.fromCall)
      throw new Error("jaringan putus");
    const all = data[stream] ?? [];
    const start = positionOf(since);
    const records = all.slice(start, start + pageSize);
    const end = start + records.length;
    return {
      protocolVersion: CATALOG_PROTOCOL_VERSION,
      stream,
      records,
      nextCursor: records.length > 0 ? catCursor(end, stream) : since,
      hasMore: end < all.length,
    };
  };
  return {
    calls,
    fetchPage,
    cursorAfter: (stream: string, position: number) =>
      catCursor(position, stream),
    breakAt: (stream: string, fromCall: number) => {
      broken = { stream, fromCall };
    },
    heal: () => {
      broken = null;
    },
  };
}
