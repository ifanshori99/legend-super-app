// Inline offline state for the checklist screens. The ops shell keeps working
// from the edge; this notice says the screen's data may be stale, without
// promising a queue the contract does not define yet.
import { WifiOff } from "lucide-react";

export function OfflineNotice({
  title,
  hint,
}: {
  title: string;
  hint: string;
}) {
  return (
    <div
      role="status"
      data-slot="offline-notice"
      className="flex items-start gap-2 rounded-container border-(length:--border-w) border-border bg-surface-2 p-3 text-sm leading-5 shadow-hairline"
    >
      <WifiOff
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span>
        <span className="font-semibold">{title}</span> {hint}
      </span>
    </div>
  );
}
