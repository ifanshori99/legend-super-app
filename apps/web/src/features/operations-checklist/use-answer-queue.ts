import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  listChecklistRuns,
  type ChecklistRun,
  type OpsChecklistItemId,
  type OpsChecklistRunId,
} from "@starter/shared/operations";
import type { AreaAccess } from "@/lib/areas/access";
import { API_MOCK } from "@/lib/api/mock-flag";
import { newIdempotencyKey } from "@/lib/idempotency";
import { useTenantContext } from "@/lib/tenant-context";
import { useOnline } from "@/lib/use-online";
import * as api from "./api.ts";
import type { RecordResultInput } from "./hooks.ts";
import { checklistRunQuery } from "./queries.ts";
import {
  CHECKLIST_ANSWER_QUEUE_KEY,
  createChecklistAnswerQueue,
  sameChecklistAnswerScope,
  type ChecklistAnswerQueueEntry,
  type ChecklistAnswerScope,
} from "./queue.ts";

const QUEUE_CHANGED_EVENT = "legend-checklist-answer-queue-changed";
const STORAGE_UNAVAILABLE = "\u0000storage-unavailable";
const STORAGE_ERROR_MESSAGE =
  "Antrean jawaban tidak dapat dibaca. Jangan hapus data browser; periksa penyimpanan perangkat lalu coba lagi.";
const REPLAY_ERROR_MESSAGE =
  "Antrean belum dapat diperbarui. Periksa penyimpanan perangkat lalu coba lagi. Jawaban belum dianggap tersimpan di server.";

function subscribeStorage(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === CHECKLIST_ANSWER_QUEUE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(QUEUE_CHANGED_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(QUEUE_CHANGED_EVENT, listener);
  };
}

function storageSnapshot(): string {
  try {
    return window.localStorage.getItem(CHECKLIST_ANSWER_QUEUE_KEY) ?? "";
  } catch {
    return STORAGE_UNAVAILABLE;
  }
}

function serverStorageSnapshot() {
  return "";
}

function queueAvailableSnapshot() {
  return Boolean(window.navigator.locks);
}

function serverQueueAvailableSnapshot() {
  return false;
}

export type ChecklistAnswerQueueView = {
  entries: readonly ChecklistAnswerQueueEntry[];
  error: string | null;
  replaying: boolean;
  ready: boolean;
  save: (input: RecordResultInput & { itemId: string }) => Promise<void>;
  retry: () => Promise<void>;
};

/** One queue owner per run page; every item shares the same replay worker. */
export function useChecklistAnswerQueue(
  run: ChecklistRun | undefined,
): ChecklistAnswerQueueView {
  const queryClient = useQueryClient();
  const online = useOnline();
  const { outlet } = useTenantContext();
  const context = useRouteContext({ strict: false }) as {
    session?: { user: { id: string } } | null;
    access?: AreaAccess;
  };
  // Mock mode deliberately has role fixtures without a real auth cookie.
  // A production session never falls back to the run's assigned person.
  const userId =
    context.session?.user.id ?? (API_MOCK ? run?.assignedTo : undefined);
  const tenantId = run?.tenantId;
  const runOutletId = run?.outletId;
  const authenticated = context.access?.authenticated;
  const selectedOutletId = outlet?.id;
  const hasOutletAccess = context.access?.outlets.some(
    (row) => row.id === runOutletId,
  );
  const scope = React.useMemo<ChecklistAnswerScope | null>(
    () =>
      tenantId &&
      runOutletId &&
      userId &&
      authenticated &&
      selectedOutletId === runOutletId &&
      hasOutletAccess
        ? { tenantId, userId, outletId: runOutletId }
        : null,
    [
      tenantId,
      runOutletId,
      userId,
      authenticated,
      hasOutletAccess,
      selectedOutletId,
    ],
  );
  const activeScope = React.useRef(scope);
  const isOnline = React.useRef(online);
  const lifetime = React.useRef<{
    active: boolean;
    controller: AbortController | null;
  }>({ active: false, controller: null });
  const [operationError, setOperationError] = React.useState<string | null>(
    null,
  );
  const stored = React.useSyncExternalStore(
    subscribeStorage,
    storageSnapshot,
    serverStorageSnapshot,
  );
  const queueAvailable = React.useSyncExternalStore(
    subscribeStorage,
    queueAvailableSnapshot,
    serverQueueAvailableSnapshot,
  );

  const queue = React.useMemo(
    () =>
      createChecklistAnswerQueue({
        storage: {
          getItem: (key) => window.localStorage.getItem(key),
          setItem: (key, value) => {
            window.localStorage.setItem(key, value);
            window.dispatchEvent(new Event(QUEUE_CHANGED_EVENT));
          },
        },
        getActiveScope: () =>
          lifetime.current.active && window.navigator.locks
            ? activeScope.current
            : null,
        withLock: async <T>(work: () => T | Promise<T>): Promise<T> => {
          if (!window.navigator.locks)
            throw new Error("Device queue locking is unavailable.");
          return await window.navigator.locks.request(
            CHECKLIST_ANSWER_QUEUE_KEY,
            async () => await work(),
          );
        },
        send: async (entry) => {
          const signal = lifetime.current.controller?.signal;
          if (
            !isOnline.current ||
            !lifetime.current.active ||
            signal?.aborted ||
            !sameChecklistAnswerScope(activeScope.current, entry.scope)
          )
            throw new Error("The checklist session or outlet changed.");
          // The body retains expectedActorUserId. The server compares it to
          // the authenticated actor atomically before replay or mutation.
          const saved = await api.recordChecklistItemResult(
            {
              runId: entry.runId as OpsChecklistRunId,
              itemId: entry.itemId as OpsChecklistItemId,
            },
            entry.body,
            { signal },
          );
          if (
            lifetime.current.active &&
            !signal?.aborted &&
            sameChecklistAnswerScope(activeScope.current, entry.scope)
          ) {
            queryClient.setQueryData(
              checklistRunQuery(entry.runId).queryKey,
              saved,
            );
            void queryClient.invalidateQueries({
              queryKey: [listChecklistRuns.id],
            });
          }
        },
      }),
    [queryClient],
  );

  const replaying = React.useSyncExternalStore(
    queue.subscribe,
    queue.isReplaying,
    serverQueueAvailableSnapshot,
  );
  const { entries, storageError } = React.useMemo(() => {
    if (stored === STORAGE_UNAVAILABLE)
      return { entries: [], storageError: STORAGE_ERROR_MESSAGE };
    try {
      return { entries: scope ? queue.list(scope) : [], storageError: null };
    } catch {
      return { entries: [], storageError: STORAGE_ERROR_MESSAGE };
    }
  }, [queue, scope, stored]);

  const retry = React.useCallback(async () => {
    const captured = activeScope.current;
    if (!captured || !isOnline.current) return;
    setOperationError(null);
    try {
      await queue.replay(captured);
    } catch {
      if (sameChecklistAnswerScope(activeScope.current, captured))
        setOperationError(REPLAY_ERROR_MESSAGE);
    }
  }, [queue]);

  React.useLayoutEffect(() => {
    const currentLifetime = {
      active: true,
      controller: new AbortController(),
    };
    lifetime.current = currentLifetime;
    activeScope.current = scope;
    isOnline.current = online;
    return () => {
      currentLifetime.active = false;
      currentLifetime.controller.abort();
    };
  }, [scope, online]);

  React.useEffect(() => {
    if (!scope || !online || !queueAvailable) return;
    let canceled = false;
    void queue.replay(scope).then(
      () => {
        if (!canceled) setOperationError(null);
      },
      () => {
        if (!canceled) setOperationError(REPLAY_ERROR_MESSAGE);
      },
    );
    return () => {
      canceled = true;
    };
  }, [scope, online, queueAvailable, queue]);

  const save = React.useCallback(
    async (input: RecordResultInput & { itemId: string }) => {
      const captured = activeScope.current;
      if (!captured || !run || run.outletId !== captured.outletId)
        throw new Error(
          "Sesi atau outlet berubah. Muat ulang sebelum menjawab.",
        );
      const { itemId, ...body } = input;
      // Until media upload supplies real persisted object IDs, only text and
      // numeric answers enter the durable queue; local preview IDs do not.
      if (body.photoMediaIds?.length || body.signatureMediaId)
        throw new Error(
          "Unggah bukti terlebih dahulu sebelum mengantrekan jawaban.",
        );
      try {
        await queue.enqueue({
          scope: captured,
          runId: run.id,
          itemId,
          body: { ...body, idempotencyKey: newIdempotencyKey() },
        });
      } catch {
        throw new Error(
          "Jawaban belum masuk antrean. Periksa ruang penyimpanan atau kirim antrean yang ada, lalu coba lagi.",
        );
      }
      if (isOnline.current) await retry();
    },
    [queue, retry, run],
  );

  return {
    // A render after an account/outlet switch must never show the previous
    // person's queued notes while the effect is still refreshing its state.
    entries: entries.filter((entry) => entry.runId === run?.id),
    error:
      storageError ??
      operationError ??
      (!queueAvailable
        ? "Antrean offline belum tersedia di browser ini. Saat online, jawaban dapat dikirim langsung. Antrean yang ada tetap dipertahankan."
        : entries.some((entry) => entry.error)
          ? "Jawaban belum dikonfirmasi server. Periksa koneksi dan akses outlet, lalu coba kirim lagi. Jika sesi berubah, muat ulang halaman. Jawaban tetap ada di antrean."
          : null),
    replaying,
    ready: scope !== null && queueAvailable,
    save,
    retry,
  };
}
