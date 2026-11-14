// Count tiles of the Status tab: a calm sentence-case label, the head count as
// the big figure, the amount below it. Columns follow the tile count so the
// last row never holds a lone tile.
import { formatRupiah } from "@starter/shared/i18n";
import { cn } from "cn";

export type SummaryTileData = {
  key: string;
  label: string;
  count: number;
  amountIdr: number;
};

// Static class names (Tailwind cannot read built strings).
function columnsFor(count: number): string {
  switch (count) {
    case 1:
      return "lg:grid-cols-1";
    case 2:
      return "lg:grid-cols-2";
    case 3:
    case 6:
      return "lg:grid-cols-3";
    case 5:
      return "lg:grid-cols-5";
    default:
      return "lg:grid-cols-4";
  }
}

export function StatusSummary({
  label,
  tiles,
  unit,
}: {
  label: string;
  tiles: readonly SummaryTileData[];
  unit: string;
}) {
  return (
    <ul
      aria-label={label}
      data-testid="status-summary"
      className={cn(
        "grid grid-cols-2 gap-3",
        // An odd last tile spans the row on phones; from lg the columns fit.
        "[&>:last-child:nth-child(odd)]:col-span-2 lg:[&>:last-child:nth-child(odd)]:col-span-1",
        columnsFor(tiles.length),
      )}
    >
      {tiles.map((tile) => (
        <li
          key={tile.key}
          className="grid min-w-0 content-start gap-1 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
        >
          <p className="text-sm text-muted-foreground">{tile.label}</p>
          <p className="tabular flex items-baseline gap-1.5 whitespace-nowrap">
            <span className="text-3xl leading-9 font-semibold">
              {tile.count}
            </span>
            <span className="text-sm text-muted-foreground">{unit}</span>
          </p>
          <p className="tabular text-sm whitespace-nowrap text-muted-foreground">
            {formatRupiah(tile.amountIdr)}
          </p>
        </li>
      ))}
    </ul>
  );
}
