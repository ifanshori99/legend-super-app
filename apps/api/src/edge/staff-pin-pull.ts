// Edge side of the staff pin down-sync (bead legend-yvhw8; PRD v1.7 §3 F6
// "Staf — PIN Perangkat", EDG-02). The cloud exports hash-only pin records at
// `GET /api/edge-sync/staff-pin-records` (services/staff-pin-sync.ts, see its
// header for the cursor and the commit-order guarantee). This is the loop
// that fetches them: follow `meta.nextCursor` page by page, apply each page
// durably with `applyStaffPinRecords` on the node's own scoped context, and
// return `meta.watermark` for the caller to store only after every page was
// applied (EDG-02: a failed pull never moves the checkpoint).
//
// Scheduling, backoff and staleness are the generic puller's job
// (device-registry-puller.ts); the checkpoint is the `staff_pins` row of
// edge_pull_checkpoints (services/edge-device-sync-store.ts).
//
// A standby pulls too: it needs the PINs to take over for a failed primary.
//
// Records carry hash and salt, so nothing here logs or puts a record into an
// error: a page that does not parse is reported without its content, and
// `applyStaffPinRecords` already strips driver detail from write failures.
import { CoreError, type ScopedTenantContext } from "@starter/shared/core";
import {
  applyStaffPinRecords,
  staffPinSyncPageSchema,
} from "../services/staff-pin-sync.ts";
import { EdgeCloudHttpError } from "./cloud-http.ts";
import { pullWithCursorRecovery } from "./device-registry-puller.ts";

/** Upper bound of pages per pull; far above any real outlet (100 per page). */
const MAX_PAGES = 1_000;

/** The cloud answered 400 to the first request of a pull: its cursor check. */
export class StaffPinCursorRefusedError extends Error {
  constructor() {
    super("The cloud refused the stored staff pin cursor");
    this.name = "StaffPinCursorRefusedError";
  }
}

export type PullStaffPinsOptions = {
  /** The edge node's own scope: where records are applied. */
  readonly context: ScopedTenantContext;
  /** Stored watermark from the previous pull; null = from the beginning. */
  readonly since: string | null;
  /** One page from the cloud for `cursor`; the raw JSON body. */
  readonly fetchPage: (cursor: string | null) => Promise<unknown>;
  readonly maxPages?: number;
  /**
   * legend-ideif: the tenant's derived peppers the page carried. Must store
   * them durably (and install them) BEFORE the page is applied, so a record of
   * a new pepper version never lands without the pepper that verifies it.
   */
  readonly onPeppers?: (
    peppers: ReadonlyArray<{
      readonly version: number;
      readonly pepper: string;
    }>,
  ) => Promise<void>;
};

export type PullStaffPinsResult = {
  readonly applied: number;
  readonly skipped: number;
  readonly pages: number;
  /** Store this after the pull; null = nothing replicated yet. */
  readonly watermark: string | null;
};

export async function pullStaffPins(
  options: PullStaffPinsOptions,
): Promise<PullStaffPinsResult> {
  const maxPages = options.maxPages ?? MAX_PAGES;
  let cursor = options.since;
  let watermark = options.since;
  let applied = 0;
  let skipped = 0;
  let pages = 0;
  for (;;) {
    if (pages >= maxPages)
      throw new CoreError(
        "CONFLICT",
        "Sinkronisasi PIN staf melebihi batas halaman.",
      );
    const raw = await options.fetchPage(cursor);
    // safeParse: a ZodError would be fine, but the page holds hash material,
    // so no parser detail travels in the error.
    const parsed = staffPinSyncPageSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Staff pin page has an unknown shape");
    const page = parsed.data;
    pages += 1;
    if (page.meta.peppers !== undefined && page.meta.peppers.length > 0)
      await options.onPeppers?.(page.meta.peppers);
    const result = await applyStaffPinRecords(options.context, page.data);
    applied += result.applied;
    skipped += result.skipped;
    // An empty page echoes the stored cursor, or has none: keep what we have.
    watermark = page.meta.watermark ?? watermark;
    if (page.meta.nextCursor === null) break;
    if (page.meta.nextCursor === cursor)
      throw new CoreError(
        "CONFLICT",
        "Cursor sinkronisasi PIN staf tidak maju.",
      );
    cursor = page.meta.nextCursor;
  }
  return { applied, skipped, pages, watermark };
}

/** True for the refusal of the stored cursor (see `createStaffPinPull`). */
export function isStaffPinCursorRefused(error: unknown): boolean {
  return error instanceof StaffPinCursorRefusedError;
}

export type StaffPinPullDeps = {
  readonly context: ScopedTenantContext;
  /** `createStaffPinRecordsFetcher` in production. */
  readonly fetchPage: (
    cursor: string | null,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly onRestart?: () => void;
  /** See `PullStaffPinsOptions.onPeppers`. */
  readonly onPeppers?: PullStaffPinsOptions["onPeppers"];
};

/**
 * The `pull` the generic puller calls. When the cloud answers HTTP 400 to the
 * first request (it no longer understands the stored cursor), retries once
 * from the start, same as the device registry: applying is idempotent and a
 * pin generation only moves forward. A 400 on a later page, or any other
 * failure, is not a cursor problem and is not retried.
 */
export function createStaffPinPull(deps: StaffPinPullDeps): (
  since: string | null,
  signal: AbortSignal,
) => Promise<{
  watermark: string | null;
}> {
  return async (since, signal) => {
    const result = await pullWithCursorRecovery(
      (from) => {
        let first = true;
        return pullStaffPins({
          context: deps.context,
          since: from,
          onPeppers: deps.onPeppers,
          fetchPage: async (cursor) => {
            const isFirst = first;
            first = false;
            try {
              return await deps.fetchPage(cursor, signal);
            } catch (error) {
              if (
                isFirst &&
                error instanceof EdgeCloudHttpError &&
                error.code === "HTTP_400"
              )
                throw new StaffPinCursorRefusedError();
              throw error;
            }
          },
        });
      },
      since,
      isStaffPinCursorRefused,
      deps.onRestart,
    );
    return { watermark: result.watermark };
  };
}
