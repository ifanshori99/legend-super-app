// A catalog/report entry of the management home: one row, one destination
// (PRD §3.36 "Laporan" and "Audit Log Viewer"). Rows keep the dense layout
// scannable; a card per link would out-shout the work queue.
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { LinkDashboardTile } from "@starter/shared/dashboard";
import { tileIcon } from "../icons";
import { contractHref } from "./href";

export function LinkTileRow({ tile }: { tile: LinkDashboardTile }) {
  const Icon = tileIcon(tile);
  return (
    <li>
      <Link
        to={contractHref(tile.targetPath)}
        className="flex min-h-control items-center gap-3 rounded-lg border-(length:--border-w) bg-card px-3 py-2.5 transition-colors duration-150 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 text-sm leading-5 font-medium">
          {tile.title}
        </span>
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      </Link>
    </li>
  );
}
