import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, CircleDot, RotateCw } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Notice } from "@/features/ws04-pos-kasir/components/shared";
import {
  isContractPending,
  useAcknowledgeCall,
  useCaptainTables,
  useOrderingConnectivity,
  useResolveCall,
  useServiceCalls,
} from "@/features/ws04-pos-order/hooks";
import type { ServiceCall } from "@/features/ws04-pos-order/types";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useOutletClock, useTenantContext } from "@/lib/tenant-context";
import { CaptainIntro } from "./captain-order-parts";
import { CaptainShell } from "./captain-shell";

/** "2026-11-12T07:32:00Z" -> "14.32" in the outlet's time zone. */
function formatClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  })
    .format(new Date(iso))
    .replace(":", ".");
}

/** How long a success message stays on screen. */
const MESSAGE_MS = 4000;

type Message = { kind: "resolved" | "acknowledged"; table: string };

// /pos/captain/panggilan — waiter calls for the captain's zone. A new call is
// accepted ("Terima"), then closed ("Selesaikan"): the bill request included.
// "Selesaikan" asks for confirmation on the card itself ("Ya, selesaikan" /
// "Batal") before anything is sent.
export function CallsScreen() {
  const t = useT();
  const outlet = useTenantContext().outlet;
  const { timeZone } = useOutletClock();
  const { mode } = useOrderingConnectivity();
  const callsQuery = useServiceCalls();
  const tablesQuery = useCaptainTables();
  const acknowledge = useAcknowledgeCall();
  const resolve = useResolveCall();
  const acknowledgeAsync = acknowledge.mutateAsync;
  const resolveAsync = resolve.mutateAsync;

  // The card asking "Ya, selesaikan?" (one at a time).
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Calls whose request is on the way. Kept here, not read from the mutations,
  // so several can be in flight and none is ever reset mid-request.
  const [sendingIds, setSendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // The success message is separate from the confirmation state.
  const [message, setMessage] = useState<Message | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const messageTimer = useRef<number | undefined>(undefined);
  const [focus, setFocus] = useState<{
    tick: number;
    callId: string | null;
    autofocus: boolean;
  }>({ tick: 0, callId: null, autofocus: false });
  const listRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const zoneOf = (tableId: string) =>
    tablesQuery.data?.find((table) => table.id === tableId)?.zone ?? null;

  // Open calls only; new ones first (oldest waiting longest on top), then accepted.
  const visible = (callsQuery.data ?? [])
    .filter((call) => call.status !== "resolved")
    .sort((a, b) =>
      a.status === b.status
        ? a.createdAt.localeCompare(b.createdAt)
        : a.status === "new"
          ? -1
          : 1,
    );

  const showMessage = useCallback((next: Message) => {
    window.clearTimeout(messageTimer.current);
    setMessage(next);
    messageTimer.current = window.setTimeout(
      () => setMessage(null),
      MESSAGE_MS,
    );
  }, []);

  useEffect(() => () => window.clearTimeout(messageTimer.current), []);

  // Move focus after an action: the card meant, or the list heading.
  useEffect(() => {
    if (focus.tick === 0) return;
    const frame = window.requestAnimationFrame(() => {
      const card = focus.callId
        ? listRef.current?.querySelector<HTMLElement>(
            `[data-call-id="${focus.callId}"]`,
          )
        : null;
      const target =
        (focus.autofocus
          ? card?.querySelector<HTMLElement>("[data-autofocus]:not([disabled])")
          : null) ?? card?.querySelector<HTMLElement>("button:not([disabled])");
      (target ?? headingRef.current)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focus]);

  const refocus = (callId: string | null, autofocus = false) =>
    setFocus((current) => ({ tick: current.tick + 1, callId, autofocus }));

  const markSending = (id: string, sending: boolean) =>
    setSendingIds((current) => {
      const next = new Set(current);
      if (sending) next.add(id);
      else next.delete(id);
      return next;
    });

  const send = async (
    call: ServiceCall,
    run: (variables: { id: string }) => Promise<unknown>,
    done: Message["kind"],
    focusAfter: string | null,
  ) => {
    if (sendingIds.has(call.id)) return;
    setActionError(null);
    markSending(call.id, true);
    try {
      await run({ id: call.id });
      showMessage({ kind: done, table: call.tableLabel });
      refocus(focusAfter);
    } catch (error) {
      setActionError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      markSending(call.id, false);
    }
  };

  const onAcknowledge = (call: ServiceCall) =>
    void send(call, acknowledgeAsync, "acknowledged", call.id);

  const onAskResolve = (call: ServiceCall) => {
    setConfirmingId(call.id);
    refocus(call.id, true);
  };

  const onCancelResolve = (call: ServiceCall) => {
    setConfirmingId(null);
    refocus(call.id);
  };

  const onConfirmResolve = (call: ServiceCall) => {
    const index = visible.findIndex((entry) => entry.id === call.id);
    const next = visible[index + 1] ?? visible[index - 1] ?? null;
    setConfirmingId(null);
    void send(call, resolveAsync, "resolved", next?.id ?? null);
  };

  const hasActionError = actionError !== null;

  return (
    <CaptainShell
      title={t("posCaptainTables.calls.title")}
      subtitle={outlet?.name}
      backTo="/pos/captain"
    >
      <div className="grid gap-4">
        <CaptainIntro
          subtitle={t("posCaptainTables.calls.subtitle")}
          action={
            API_MOCK ? (
              <Badge tone="neutral">{t("common.sampleData")}</Badge>
            ) : undefined
          }
        />

        {mode === "edge_only" && (
          <Notice tone="warning" title={t("posCaptainTables.offline.title")}>
            {t("posCaptainTables.offline.body")}
          </Notice>
        )}

        {hasActionError && (
          <Notice
            tone="danger"
            title={
              isContractPending(actionError)
                ? t("posCaptainTables.calls.actionError.pendingTitle")
                : t("posCaptainTables.calls.actionError.title")
            }
          >
            {isContractPending(actionError)
              ? t("posCaptainTables.calls.actionError.pendingDescription")
              : t("posCaptainTables.calls.actionError.description")}
          </Notice>
        )}

        {/* Always in the page, so each confirmation is announced. */}
        <div role="status" aria-live="polite" className="empty:sr-only">
          {message && !hasActionError && (
            <Notice
              tone="info"
              title={t(
                message.kind === "resolved"
                  ? "posCaptainTables.calls.resolved"
                  : "posCaptainTables.calls.acknowledged",
                { table: message.table },
              )}
            />
          )}
        </div>

        {callsQuery.isError && callsQuery.data && (
          <Notice tone="warning" title={t("posCaptainTables.calls.stale")} />
        )}

        <h2 ref={headingRef} tabIndex={-1} className="sr-only">
          {t("posCaptainTables.calls.listLabel")}
        </h2>

        {callsQuery.isPending ? (
          <div
            role="status"
            aria-busy="true"
            aria-label={t("posCaptainTables.calls.loading")}
            className="grid gap-3"
          >
            <Skeleton className="h-44 rounded-container" />
            <Skeleton className="h-24 rounded-container" />
          </div>
        ) : callsQuery.isError && !callsQuery.data ? (
          <ErrorState
            error={callsQuery.error}
            title={
              isContractPending(callsQuery.error)
                ? t("posCaptainTables.calls.error.pendingTitle")
                : t("posCaptainTables.calls.error.title")
            }
            description={
              isContractPending(callsQuery.error)
                ? t("posCaptainTables.calls.error.pendingDescription")
                : t("posCaptainTables.calls.error.description")
            }
            action={
              <Button
                variant="outline"
                onClick={() => void callsQuery.refetch()}
              >
                <RotateCw aria-hidden="true" />
                {t("posCaptainTables.calls.error.retry")}
              </Button>
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title={t("posCaptainTables.calls.empty.title")}
            description={t("posCaptainTables.calls.empty.description")}
          />
        ) : (
          <>
            <ul
              ref={listRef}
              aria-label={t("posCaptainTables.calls.listLabel")}
              className="grid gap-3"
            >
              {visible.map((call) => {
                const zone = zoneOf(call.tableId);
                const time = formatClock(call.createdAt, timeZone);
                const isNew = call.status === "new";
                return (
                  <li key={call.id} data-call-id={call.id}>
                    <CallCard
                      call={call}
                      zone={zone}
                      time={time}
                      busy={sendingIds.has(call.id)}
                      confirming={confirmingId === call.id}
                      onAct={() =>
                        isNew ? onAcknowledge(call) : onAskResolve(call)
                      }
                      onConfirm={() => onConfirmResolve(call)}
                      onCancel={() => onCancelResolve(call)}
                    />
                  </li>
                );
              })}
            </ul>
            <p className="text-sm text-muted-foreground">
              {t("posCaptainTables.calls.hint")}
            </p>
          </>
        )}
      </div>
    </CaptainShell>
  );
}

function CallCard({
  call,
  zone,
  time,
  busy,
  confirming,
  onAct,
  onConfirm,
  onCancel,
}: {
  call: ServiceCall;
  zone: string | null;
  time: string;
  busy: boolean;
  confirming: boolean;
  onAct: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const isNew = call.status === "new";
  const table = t("posCaptainTables.calls.table", { table: call.tableLabel });
  const typeLabel = t(`posCaptainTables.calls.type.${call.type}`);
  // The reason is what the guest asked for; fall back to the call type.
  const headline = call.reason || typeLabel;
  const meta = t("posCaptainTables.calls.meta", {
    detail: isNew ? (zone ?? typeLabel) : headline,
    time,
  });
  return (
    <article
      data-slot="captain-call-card"
      data-status={call.status}
      aria-label={table}
      className={
        isNew
          ? "rounded-container border-2 border-l-[6px] border-border border-l-warning bg-card p-4"
          : "rounded-container border-2 border-border bg-card p-card"
      }
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className={isNew ? "type-title" : "text-lg leading-6 font-bold"}>
          {table}
        </h2>
        {isNew ? (
          <Badge tone="warning" className="px-3 py-1 text-sm">
            <CircleDot aria-hidden="true" />
            {t("posCaptainTables.calls.status.new")}
          </Badge>
        ) : (
          <Badge tone="success" className="px-3 py-1 text-sm">
            <CircleCheck aria-hidden="true" />
            {t("posCaptainTables.calls.status.acknowledged")}
          </Badge>
        )}
      </div>
      {isNew && (
        <p className="mt-2 text-(length:--density-text) leading-6 font-bold">
          {headline}
        </p>
      )}
      <p className="mt-1 text-sm leading-5 text-muted-foreground">{meta}</p>
      <div className="mt-3 border-t-2 border-border pt-3">
        {confirming && !isNew ? (
          <div role="group" aria-label={table} className="grid gap-3">
            <p className="text-(length:--density-text) leading-6 font-bold">
              {t("posCaptainTables.calls.confirmQuestion", {
                table: call.tableLabel,
              })}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Button
                variant="default"
                loading={busy}
                onClick={onConfirm}
                aria-label={t("posCaptainTables.calls.confirmYesFor", {
                  table: call.tableLabel,
                })}
              >
                {t("posCaptainTables.calls.confirmYes")}
              </Button>
              <Button
                variant="outline"
                data-autofocus=""
                disabled={busy}
                onClick={onCancel}
                aria-label={t("posCaptainTables.calls.confirmCancelFor", {
                  table: call.tableLabel,
                })}
              >
                {t("posCaptainTables.calls.confirmCancel")}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant={isNew ? "default" : "outline"}
            loading={busy}
            onClick={onAct}
            aria-label={t(
              isNew
                ? "posCaptainTables.calls.acknowledgeFor"
                : "posCaptainTables.calls.resolveFor",
              { table: call.tableLabel },
            )}
            className="w-full"
          >
            {isNew
              ? t("posCaptainTables.calls.acknowledge")
              : t("posCaptainTables.calls.resolve")}
          </Button>
        )}
      </div>
    </article>
  );
}
