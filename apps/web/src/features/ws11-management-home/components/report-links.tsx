// Catalog and audit entries of the management home (PRD §3.36 "Laporan" and
// "Audit Log Viewer") as one inner card of a double shell: rows keep the
// dense layout scannable, a card per link would out-shout the work queue.
import { Link } from "@tanstack/react-router";
import { ChevronRight, Files, ScrollText } from "lucide-react";
import { CardShell, CardShellBody } from "@/components/ui/card";
import type { LinkDashboardTile } from "@starter/shared/dashboard";
import { contractHref } from "./href";

export function ReportLinks({
  tiles,
}: {
  tiles: readonly LinkDashboardTile[];
}) {
  return (
    <CardShell>
      <CardShellBody>
        <ul className="divide-y divide-border">
          {tiles.map((tile) => {
            const Icon = tile.targetPath.includes("audit") ? ScrollText : Files;
            return (
              <li key={tile.key}>
                <Link
                  to={contractHref(tile.targetPath)}
                  className="flex min-h-control items-center gap-3 px-4 py-3 transition-colors duration-(--duration-fast) hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-container bg-surface-3 text-muted-foreground">
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
          })}
        </ul>
      </CardShellBody>
    </CardShell>
  );
}
