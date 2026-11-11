import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Circle, CircleDot } from "lucide-react";
import { useT } from "@/components/i18n";
import type { CaptainTable } from "@/features/ws04-pos-order/types";

// One table on the picker. Occupied is a gray fill plus the "Terisi" text and a
// filled dot; empty is the plain card plus "Kosong" and a hollow dot, so the
// state never depends on color. The whole tile is the 112 px touch target.
export function TableTile({ table }: { table: CaptainTable }) {
  const t = useT();
  const occupied = table.status === "occupied";
  const Icon = occupied ? CircleDot : Circle;
  const detail = table.hasOpenCall
    ? t("posCaptainTables.tables.openCall")
    : occupied
      ? table.qrSessionActive
        ? t("posCaptainTables.tables.qrSession")
        : null
      : t("posCaptainTables.tables.seats", { count: table.seats });

  return (
    <Link
      to="/pos/captain/meja/$tableId"
      params={{ tableId: table.id }}
      data-slot="captain-table-tile"
      data-status={table.status}
      className={cn(
        "flex h-full min-h-28 min-w-0 flex-col gap-1 rounded-container border-2 border-border p-card text-left pressable focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        occupied ? "bg-surface-3" : "bg-card",
      )}
    >
      <span className="text-xl leading-7 font-bold">{table.label}</span>
      <span className="flex items-center gap-1.5 text-(length:--density-text)">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {occupied
          ? t("posCaptainTables.tables.status.occupied", {
              count: table.guestCount,
            })
          : t("posCaptainTables.tables.status.empty")}
      </span>
      {detail && (
        <span className="text-(length:--density-text) text-muted-foreground">
          {detail}
        </span>
      )}
    </Link>
  );
}
