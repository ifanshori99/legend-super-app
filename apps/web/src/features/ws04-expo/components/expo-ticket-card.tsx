// One order on the expo screen: every station's ticket for one table (or one
// pickup number), whether it is complete, and who runs it (PRD §3 F12). The
// card is the same at 390px and 1440px; only the grid it sits in changes.
import type { ExpoTicket } from "@starter/shared/kitchen";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/badge";
import { formatOutletTime } from "../format.ts";
import { ChannelBadge } from "./channel-badge.tsx";
import { StationStatusBadge } from "./station-status-badge.tsx";
import { expoTargetLabel } from "./target-label.ts";

export function ExpoTicketCard({
  ticket,
  runnerName,
  onAssign,
}: {
  ticket: ExpoTicket;
  /** Resolved from the runner list; null when nobody is assigned or known. */
  runnerName: string | null;
  onAssign: () => void;
}) {
  const t = useT();
  const done = ticket.stations.filter((row) => row.status === "done").length;
  const target = expoTargetLabel(ticket, t);

  return (
    <article
      data-slot="expo-ticket"
      data-complete={ticket.isComplete ? "true" : "false"}
      className="flex min-w-0 flex-col gap-3 rounded-xl border-(length:--border-w) bg-card p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-2xl leading-8 font-bold tabular">{target}</p>
          <p className="text-sm leading-5 text-muted-foreground tabular">
            {t("expo.stationProgress", {
              done,
              total: ticket.stations.length,
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <ChannelBadge channel={ticket.channel} />
          {ticket.isComplete && <StatusPill status="ready" />}
        </div>
      </div>

      <ul className="grid gap-1.5">
        {ticket.stations.map((station) => (
          <li
            key={station.ticketId}
            className="flex min-w-0 items-center justify-between gap-3"
          >
            <span className="truncate text-(length:--density-text)">
              {station.stationName}
            </span>
            <StationStatusBadge status={station.status} />
          </li>
        ))}
      </ul>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t-(length:--border-w) pt-3">
        <div className="min-w-0">
          <p className="truncate text-sm leading-5 font-semibold">
            {runnerName === null
              ? t("expo.runnerPending")
              : t("expo.runnerLabel", { name: runnerName })}
          </p>
          {ticket.isComplete && ticket.readyAt !== null && (
            <p className="text-sm leading-5 text-muted-foreground tabular">
              {t("expo.readyAt", { time: formatOutletTime(ticket.readyAt) })}
            </p>
          )}
        </div>
        <Button
          variant={ticket.isComplete ? "default" : "outline"}
          size="sm"
          onClick={onAssign}
        >
          {runnerName === null
            ? t("expo.assignRunner")
            : t("expo.changeRunner")}
        </Button>
      </div>
    </article>
  );
}
