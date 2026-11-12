// Kind pill shared by the supervisor queue and detail (bead legend-ydf2), so a
// request kind never reads as two different badges. A kind is a category, not a
// status, so it uses the neutral badge.
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import type { RequestQueueItem } from "../queue.ts";
import { KIND_LABEL_KEYS } from "./queue-model.ts";

/** Kind label: the specific title (e.g. "Cuti tahunan") or the kind itself. */
export function useKindLabel() {
  const t = useT();
  return (item: Pick<RequestQueueItem, "kind" | "title">) =>
    item.title.trim() !== "" ? item.title : t(KIND_LABEL_KEYS[item.kind]);
}

export function QueueKindPill({
  item,
}: {
  item: Pick<RequestQueueItem, "kind" | "title">;
}) {
  const label = useKindLabel()(item);
  return (
    <Badge title={label} className="max-w-full truncate">
      {label}
    </Badge>
  );
}
