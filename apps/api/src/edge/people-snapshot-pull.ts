// Edge side of the people snapshot pull (design hris-edge-replication.md 3.1
// and 3.3). GET /api/edge-sync/people-snapshot returns the full snapshot for
// the credential's outlet; this fetches it with `If-None-Match` from the stored
// ETag, validates it, and hands it to `applyEdgePeopleSnapshot` (one
// transaction, all or nothing).
//
// - 304: only `last_checked_at` moves (`markEdgePeopleSnapshotChecked`).
// - 200: the body must pass `edgePeopleSnapshotSchema` and the response must
//   carry an ETag; otherwise nothing is applied.
//
// Scheduling, backoff and staleness are the generic puller's job
// (device-registry-puller.ts). The checkpoint here is the
// `edge_people_sync_state` row, written by the apply itself, so the generic
// puller's own load/save carry no watermark.
//
// Never put the credential, the snapshot or SQL parameters in an error: codes
// only.
import {
  EDGE_PEOPLE_SNAPSHOT_GENERATED_AT_HEADER,
  EDGE_PEOPLE_SNAPSHOT_PATH,
  edgePeopleSnapshotSchema,
} from "@starter/shared/edge/people-snapshot";
import {
  cloudGetJsonConditional,
  EdgeCloudHttpError,
  type CloudGetOptions,
} from "./cloud-http.ts";
import { stampEdgeIdentityPull } from "../services/edge-device-sync-store.ts";
import { edgeNodeContext } from "../services/edge-node.service.ts";
import { parseEdgeCredential } from "./credential.ts";
import {
  createDeviceRegistryPuller,
  type DeviceRegistryPuller,
  type DeviceRegistryPullerDeps,
} from "./device-registry-puller.ts";
import {
  applyEdgePeopleSnapshot,
  loadEdgePeopleSyncState,
  markEdgePeopleSnapshotChecked,
} from "./people-snapshot-apply.ts";

type Database = NonNullable<
  Parameters<typeof applyEdgePeopleSnapshot>[0]["database"]
>;

/**
 * code: EDGE_NODE_CREDENTIAL, CLOUD_<code> (HTTP_<status>, TIMEOUT, NETWORK,
 * ABORTED, BAD_JSON), BAD_SNAPSHOT (the body is not a valid snapshot) or
 * BAD_RESPONSE (a 200 without an ETag).
 */
export class EdgePeopleSnapshotPullError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Edge people snapshot pull failed (${code})`);
    this.name = "EdgePeopleSnapshotPullError";
    this.code = code;
  }
}

export type PeopleSnapshotPullConfig = Pick<
  CloudGetOptions,
  "cloudUrl" | "credential"
>;

export type PullPeopleSnapshotOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Default: the shared pool. Injected by tests that run a second database. */
  database?: Database;
  now?: Date;
};

export type PullPeopleSnapshotResult = { status: "unchanged" | "applied" };

function parseGeneratedAt(value: string | null): Date | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** One pull: conditional GET, then mark-checked (304) or validate + apply (200). */
export async function pullPeopleSnapshotOnce(
  config: PeopleSnapshotPullConfig,
  options: PullPeopleSnapshotOptions = {},
): Promise<PullPeopleSnapshotResult> {
  const claims = parseEdgeCredential(config.credential);
  if (!claims) throw new EdgePeopleSnapshotPullError("EDGE_NODE_CREDENTIAL");
  const stored = await loadEdgePeopleSyncState({
    claims,
    database: options.database,
  });
  let response: Awaited<ReturnType<typeof cloudGetJsonConditional>>;
  try {
    response = await cloudGetJsonConditional({
      cloudUrl: config.cloudUrl,
      credential: config.credential,
      path: EDGE_PEOPLE_SNAPSHOT_PATH,
      etag: stored?.snapshotEtag ?? null,
      generatedAtHeader: EDGE_PEOPLE_SNAPSHOT_GENERATED_AT_HEADER,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
  } catch (error) {
    throw new EdgePeopleSnapshotPullError(
      error instanceof EdgeCloudHttpError
        ? `CLOUD_${error.code}`
        : "CLOUD_REQUEST",
    );
  }
  if (response.status === 304) {
    await markEdgePeopleSnapshotChecked({
      claims,
      now: options.now,
      database: options.database,
    });
    return { status: "unchanged" };
  }
  // safeParse: the body holds people data, so no parser detail travels.
  const parsed = edgePeopleSnapshotSchema.safeParse(response.body);
  if (!parsed.success) throw new EdgePeopleSnapshotPullError("BAD_SNAPSHOT");
  if (response.etag === null || response.etag.length === 0)
    throw new EdgePeopleSnapshotPullError("BAD_RESPONSE");
  await applyEdgePeopleSnapshot({
    claims,
    snapshot: parsed.data,
    etag: response.etag,
    generatedAt: parseGeneratedAt(response.generatedAt),
    now: options.now,
    database: options.database,
  });
  return { status: "applied" };
}

export type PeopleSnapshotPullerDeps = {
  config: PeopleSnapshotPullConfig;
  intervalMs: number;
  staleAfterMs: number;
  maxBackoffMs: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  database?: Database;
  onStaleChange?: DeviceRegistryPullerDeps["onStaleChange"];
  onError?: DeviceRegistryPullerDeps["onError"];
  now?: () => Date;
  random?: () => number;
  setTimer?: DeviceRegistryPullerDeps["setTimer"];
  clearTimer?: DeviceRegistryPullerDeps["clearTimer"];
};

/**
 * The registry puller's scheduler (capped backoff with jitter, `runOnce`
 * de-dup, abort on `stop()`) around `pullPeopleSnapshotOnce`. The people
 * snapshot keeps no watermark: its ETag and times live in
 * `edge_people_sync_state`, written by the apply and the 304 mark. The time of
 * the last successful check seeds the staleness window after a restart.
 */
export function createPeopleSnapshotPuller(
  deps: PeopleSnapshotPullerDeps,
): DeviceRegistryPuller {
  const claims = parseEdgeCredential(deps.config.credential);
  if (!claims) throw new EdgePeopleSnapshotPullError("EDGE_NODE_CREDENTIAL");
  return createDeviceRegistryPuller({
    pull: async (_since, signal) => {
      await pullPeopleSnapshotOnce(deps.config, {
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.timeoutMs,
        signal,
        database: deps.database,
      });
      return { watermark: null };
    },
    load: async () => {
      const stored = await loadEdgePeopleSyncState({
        claims,
        database: deps.database,
      });
      return { watermark: null, lastSuccessAt: stored?.lastCheckedAt ?? null };
    },
    save: () =>
      stampEdgeIdentityPull(
        edgeNodeContext(claims),
        claims.edgeNodeId,
        "people",
        deps.database,
      ),
    intervalMs: deps.intervalMs,
    staleAfterMs: deps.staleAfterMs,
    maxBackoffMs: deps.maxBackoffMs,
    now: deps.now,
    random: deps.random,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    onStaleChange: deps.onStaleChange,
    onError: deps.onError,
  });
}
