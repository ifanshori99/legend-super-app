// Expo screen (PRD §3 F12 "Expo"): one card per order, every station's ticket
// on it, complete orders at the top and the runner assignment on the card.
// States: loading, empty, error (docs/frontend.md; every list has them).
import { useState } from "react";
import type { ExpoRunner, ExpoTicket } from "@starter/shared/kitchen";
import { useT } from "@/components/i18n";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors.ts";
import { useTenantContext } from "@/lib/tenant-context";
import { useAssignRunner, useExpoBoard, useExpoRunners } from "../hooks.ts";
import { ExpoTicketCard } from "./expo-ticket-card.tsx";
import { RunnerPicker } from "./runner-picker.tsx";
import { KitchenScreenHeader } from "./screen-header.tsx";
import { expoTargetLabel } from "./target-label.ts";

/**
 * Keyed by outlet: switching outlet in the shell starts a fresh screen, so an
 * open runner picker of the previous outlet cannot carry over.
 */
export function ExpoScreen() {
  const { outlet } = useTenantContext();
  return <ExpoContent key={outlet?.id ?? "none"} />;
}

function ExpoContent() {
  const t = useT();
  const toast = useToast();
  // The outlet the shell selected from the session's assigned outlets.
  const { outlet } = useTenantContext();
  const outletId = outlet?.id;
  const board = useExpoBoard(outletId);
  const runners = useExpoRunners(outletId);
  const assign = useAssignRunner(outletId);
  const [picking, setPicking] = useState<ExpoTicket | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  const runnerNames = new Map(
    (runners.data ?? []).map((runner) => [runner.userId, runner.name]),
  );
  const tickets = board.data?.tickets ?? [];
  const ready = tickets.filter((row) => row.isComplete);
  const preparing = tickets.filter((row) => !row.isComplete);

  function openPicker(ticket: ExpoTicket) {
    setPickError(null);
    setPicking(ticket);
  }

  function handlePick(runnerId: ExpoRunner["userId"]) {
    const ticket = picking;
    if (!ticket) return;
    const target = expoTargetLabel(ticket, t);
    setPickError(null);
    assign.mutate(
      { orderId: ticket.orderId, runnerId },
      {
        onSuccess: () => {
          toast({
            title: t("expo.runnerAssignedToast", { target }),
            tone: "success",
          });
          setPicking(null);
        },
        onError: (error) =>
          setPickError(
            error instanceof ApiError ? error.message : t("state.errorHint"),
          ),
      },
    );
  }

  const header = (
    <KitchenScreenHeader
      title={t("expo.title")}
      intro={t("expo.intro")}
      current="expo"
      updatedAt={board.data?.generatedAt ?? null}
      refreshPending={board.isFetching}
      onRefresh={() => void board.refetch()}
    />
  );

  if (outletId && board.isPending) {
    return (
      <div className="flex w-full flex-col gap-5">
        {header}
        <div
          aria-busy="true"
          className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3"
        >
          <span className="sr-only">{t("expo.loading")}</span>
          {[0, 1, 2, 3].map((card) => (
            <Skeleton key={card} className="h-56 w-full rounded-container" />
          ))}
        </div>
      </div>
    );
  }

  if (board.isError && !board.data) {
    return (
      <div className="flex w-full flex-col gap-5">
        {header}
        <ErrorState
          error={board.error}
          title={t("expo.errorTitle")}
          description={t("expo.errorHint")}
          onRetry={() => void board.refetch()}
        />
      </div>
    );
  }

  if (tickets.length === 0) {
    return (
      <div className="flex w-full flex-col gap-5">
        {header}
        <EmptyState
          title={t("expo.emptyTitle")}
          description={t("expo.emptyHint")}
        />
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-5">
      {header}

      {ready.length > 0 && (
        <section aria-labelledby="expo-ready" className="flex flex-col gap-3">
          <div className="min-w-0">
            <h2 id="expo-ready" className="type-title tabular">
              {t("expo.readyTitle")} · {ready.length}
            </h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("expo.readyHint")}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {ready.map((ticket) => (
              <ExpoTicketCard
                key={ticket.orderId}
                ticket={ticket}
                runnerName={
                  ticket.runnerId === null
                    ? null
                    : (runnerNames.get(ticket.runnerId) ?? null)
                }
                onAssign={() => openPicker(ticket)}
              />
            ))}
          </div>
        </section>
      )}

      {preparing.length > 0 && (
        <section
          aria-labelledby="expo-preparing"
          className="flex flex-col gap-3"
        >
          <div className="min-w-0">
            <h2 id="expo-preparing" className="type-title tabular">
              {t("expo.preparingTitle")} · {preparing.length}
            </h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("expo.preparingHint")}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {preparing.map((ticket) => (
              <ExpoTicketCard
                key={ticket.orderId}
                ticket={ticket}
                runnerName={
                  ticket.runnerId === null
                    ? null
                    : (runnerNames.get(ticket.runnerId) ?? null)
                }
                onAssign={() => openPicker(ticket)}
              />
            ))}
          </div>
        </section>
      )}

      <RunnerPicker
        open={picking !== null}
        onOpenChange={(open) => {
          if (!open && !assign.isPending) setPicking(null);
        }}
        ticket={picking}
        runners={runners.data ?? []}
        runnersPending={runners.isPending}
        runnersFailed={runners.isError}
        runnersError={runners.error}
        onRetryRunners={() => void runners.refetch()}
        assignedRunnerId={picking?.runnerId ?? null}
        onPick={handlePick}
        picking={assign.isPending}
        pickError={pickError}
      />
    </div>
  );
}
