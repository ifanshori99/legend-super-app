// One order on the expo screen: every station's ticket for one table (or one
// pickup number), whether it is complete, and who runs it (PRD §3 F12). The
// card is the same at 390px and 1440px; only the grid it sits in changes.
// The band carries the order state the way a KDS ticket does (DESIGN.md §5,
// owner Q26): ready to run is the success tint, still preparing the raised
// neutral, so a board of orders never spends the accent budget.
import type { ExpoTicket } from "@starter/shared/kitchen";
import { CircleCheck, Clock } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { StatusBand } from "@/components/ui/status-band";
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
      className="flex min-w-0 flex-col overflow-hidden rounded-container border-(length:--border-w) bg-card"
    >
      <StatusBand
        tone={ticket.isComplete ? "success" : "neutral"}
        icon={ticket.isComplete ? CircleCheck : Clock}
        label={t(ticket.isComplete ? "expo.readyTitle" : "expo.preparingTitle")}
        aside={<ChannelBadge channel={ticket.channel} />}
      >
        <p className="text-3xl leading-9 font-bold tabular">{target}</p>
        <p className="text-sm leading-5 font-semibold tabular">
          {t("expo.stationProgress", {
            done,
            total: ticket.stations.length,
          })}
        </p>
        {ticket.isComplete && ticket.readyAt !== null && (
          <p className="text-sm leading-5 font-semibold tabular">
            {t("expo.readyAt", { time: formatOutletTime(ticket.readyAt) })}
          </p>
        )}
      </StatusBand>

      <div className="flex flex-1 flex-col gap-3 p-4">
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
          </div>
          {/* Neutral, not the filled accent: several ready orders can share
              the board (DESIGN.md §2, owner Q21). */}
          <Button
            variant={ticket.isComplete ? "secondary" : "outline"}
            size="sm"
            onClick={onAssign}
          >
            {runnerName === null
              ? t("expo.assignRunner")
              : t("expo.changeRunner")}
          </Button>
        </div>
      </div>
    </article>
  );
}
