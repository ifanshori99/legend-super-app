import type { EndpointInput } from "@starter/shared/api";
import type { recordChecklistItemResult } from "@starter/shared/operations";

export const CHECKLIST_ANSWER_QUEUE_KEY =
  "legend.operations.checklist.answers.v1";
// A device must refuse new answers visibly before it can silently evict work.
const MAX_ANSWERS_PER_SCOPE = 100;

export type ChecklistAnswerScope = {
  tenantId: string;
  userId: string;
  outletId: string;
};

export type ChecklistAnswerBody = EndpointInput<
  typeof recordChecklistItemResult
>["body"];

export type ChecklistAnswerSubmission = {
  scope: ChecklistAnswerScope;
  runId: string;
  itemId: string;
  body: ChecklistAnswerBody;
};

export type ChecklistAnswerQueueEntry = ChecklistAnswerSubmission & {
  idempotencyKey: string;
  queuedAt: string;
  error?: string;
  resolution?: "conflict";
};

type QueueStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => unknown;
};

export function sameChecklistAnswerScope(
  left: ChecklistAnswerScope | null,
  right: ChecklistAnswerScope | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.outletId === right.outletId
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isEntry(value: unknown): value is ChecklistAnswerQueueEntry {
  if (!object(value) || !object(value.scope) || !object(value.body))
    return false;
  const { scope, body } = value;
  return (
    text(scope.tenantId) &&
    text(scope.userId) &&
    text(scope.outletId) &&
    text(value.runId) &&
    text(value.itemId) &&
    text(value.queuedAt) &&
    Number.isFinite(Date.parse(value.queuedAt)) &&
    text(value.idempotencyKey) &&
    value.idempotencyKey === body.idempotencyKey &&
    (body.expectedActorUserId === undefined ||
      body.expectedActorUserId === scope.userId) &&
    ["pending", "done", "failed"].includes(String(body.status)) &&
    (body.numberValue === undefined ||
      body.numberValue === null ||
      typeof body.numberValue === "string") &&
    (body.note === undefined ||
      body.note === null ||
      typeof body.note === "string") &&
    (body.photoMediaIds === undefined ||
      (Array.isArray(body.photoMediaIds) && body.photoMediaIds.every(text))) &&
    (body.signatureMediaId === undefined ||
      body.signatureMediaId === null ||
      text(body.signatureMediaId)) &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.resolution === undefined || value.resolution === "conflict")
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fingerprint(entry: ChecklistAnswerSubmission): string {
  // Object field order is not part of an answer; photo order is preserved.
  return JSON.stringify(
    [entry.runId, entry.itemId, entry.body],
    (_key, value: unknown) =>
      object(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          )
        : value,
  );
}

/** A durable attempt keeps its original body and key until the API confirms it. */
export function createChecklistAnswerQueue({
  storage,
  send,
  getActiveScope,
  now = () => new Date().toISOString(),
  withLock,
}: {
  storage: QueueStorage;
  send: (entry: ChecklistAnswerQueueEntry) => Promise<unknown>;
  getActiveScope: () => ChecklistAnswerScope | null;
  now?: () => string;
  withLock?: <T>(work: () => T | Promise<T>) => Promise<T>;
}) {
  let mutation: Promise<unknown> = Promise.resolve();
  const lock =
    withLock ??
    function <T>(work: () => T | Promise<T>): Promise<T> {
      const next = mutation.then(work);
      mutation = next.catch(() => undefined);
      return next;
    };
  function read(): ChecklistAnswerQueueEntry[] {
    const raw = storage.getItem(CHECKLIST_ANSWER_QUEUE_KEY);
    if (raw === null) return [];
    const saved: unknown = JSON.parse(raw);
    if (
      !object(saved) ||
      saved.version !== 1 ||
      !Array.isArray(saved.entries) ||
      !saved.entries.every(isEntry)
    ) {
      throw new Error("The checklist answer queue cannot be read safely.");
    }
    return saved.entries.map((entry) => ({
      ...entry,
      // Older local entries already captured an actor in their scope. Enrich
      // only missing metadata from that snapshot, never the current session.
      body: {
        ...entry.body,
        expectedActorUserId: entry.scope.userId as NonNullable<
          ChecklistAnswerBody["expectedActorUserId"]
        >,
      },
    }));
  }

  function write(entries: ChecklistAnswerQueueEntry[]) {
    storage.setItem(
      CHECKLIST_ANSWER_QUEUE_KEY,
      JSON.stringify({ version: 1, entries }),
    );
  }

  function list(scope: ChecklistAnswerScope): ChecklistAnswerQueueEntry[] {
    return clone(
      read().filter(
        (entry) =>
          sameChecklistAnswerScope(entry.scope, scope) && !entry.resolution,
      ),
    );
  }

  function listConflicts(
    scope: ChecklistAnswerScope,
  ): ChecklistAnswerQueueEntry[] {
    return clone(
      read().filter(
        (entry) =>
          sameChecklistAnswerScope(entry.scope, scope) &&
          entry.resolution === "conflict",
      ),
    );
  }

  async function discardConflict(
    scope: ChecklistAnswerScope,
    idempotencyKey: string,
  ): Promise<void> {
    await lock(() => {
      write(
        read().filter(
          (entry) =>
            !sameChecklistAnswerScope(entry.scope, scope) ||
            entry.idempotencyKey !== idempotencyKey ||
            entry.resolution !== "conflict",
        ),
      );
    });
  }

  async function enqueue(
    input: ChecklistAnswerSubmission,
  ): Promise<ChecklistAnswerQueueEntry> {
    const entry = clone({
      ...input,
      body: { ...input.body, expectedActorUserId: input.scope.userId },
      idempotencyKey: input.body.idempotencyKey,
      queuedAt: now(),
    });
    if (!isEntry(entry)) throw new Error("The checklist answer is invalid.");
    return lock(() => {
      const entries = read();
      const existing = entries.find(
        (row) =>
          sameChecklistAnswerScope(row.scope, entry.scope) &&
          row.idempotencyKey === entry.idempotencyKey,
      );
      if (existing) {
        if (fingerprint(existing) !== fingerprint(entry))
          throw new Error("This checklist attempt already has another answer.");
        return clone(existing);
      }
      if (
        entries.some(
          (row) =>
            sameChecklistAnswerScope(row.scope, entry.scope) &&
            row.runId === entry.runId &&
            row.itemId === entry.itemId &&
            row.resolution === "conflict",
        )
      ) {
        throw new Error(
          "Resolve the local answer conflict before answering again.",
        );
      }
      if (
        entries.filter((row) =>
          sameChecklistAnswerScope(row.scope, entry.scope),
        ).length >= MAX_ANSWERS_PER_SCOPE
      ) {
        throw new Error("The checklist answer queue is full.");
      }
      write([...entries, entry]);
      return clone(entry);
    });
  }

  type ReplayResult = { sent: number; pending: number };
  let replaying: Promise<ReplayResult> | null = null;
  let replayingScope: ChecklistAnswerScope | null = null;
  const listeners = new Set<() => void>();

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function isReplaying() {
    return replaying !== null;
  }

  async function drain(scope: ChecklistAnswerScope): Promise<ReplayResult> {
    let sent = 0;
    while (sameChecklistAnswerScope(scope, getActiveScope())) {
      const entry = list(scope)[0];
      if (!entry) break;
      try {
        await send(clone(entry));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "The answer was not sent.";
        const conflict =
          object(error) && error.code === "CHECKLIST_ANSWER_CONFLICT";
        // Enqueue can run while send awaits. Always re-read before changing
        // one attempt, otherwise a late response could overwrite newer work.
        await lock(() => {
          write(
            read().map((row) =>
              sameChecklistAnswerScope(row.scope, scope) &&
              (conflict
                ? row.runId === entry.runId && row.itemId === entry.itemId
                : row.idempotencyKey === entry.idempotencyKey)
                ? {
                    ...row,
                    error: message,
                    ...(conflict ? { resolution: "conflict" as const } : {}),
                  }
                : row,
            ),
          );
        });
        // A server-final answer cannot be retried. Keep every local attempt
        // for that item for explicit resolution and let other items drain.
        if (conflict) continue;
        break;
      }
      await lock(() => {
        write(
          read().filter(
            (row) =>
              !sameChecklistAnswerScope(row.scope, scope) ||
              row.idempotencyKey !== entry.idempotencyKey,
          ),
        );
      });
      sent += 1;
    }
    return {
      sent,
      pending: list(scope).length + listConflicts(scope).length,
    };
  }

  function replay(scope: ChecklistAnswerScope): Promise<ReplayResult> {
    if (replaying) {
      if (sameChecklistAnswerScope(replayingScope, scope)) return replaying;
      return replaying.then(() => replay(scope));
    }
    replayingScope = scope;
    replaying = drain(scope).finally(() => {
      replaying = null;
      replayingScope = null;
      for (const listener of listeners) listener();
    });
    for (const listener of listeners) listener();
    return replaying;
  }

  return {
    enqueue,
    list,
    listConflicts,
    discardConflict,
    replay,
    subscribe,
    isReplaying,
  };
}
