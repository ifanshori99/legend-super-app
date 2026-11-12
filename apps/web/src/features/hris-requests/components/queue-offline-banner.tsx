// "Tidak ada koneksi" banner of the supervisor screens: a decision is never
// queued offline, it waits until the connection is back (bead legend-ydf2).
import { WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";

export function QueueOfflineBanner() {
  const t = useT();
  return (
    <div
      role="status"
      className="flex flex-col items-start gap-1.5 rounded-container border-(length:--border-w) bg-warning-subtle p-card"
    >
      <StatusPill status="warning" icon={WifiOff}>
        {t("hrisRequestsQueue.offline.title")}
      </StatusPill>
      <p className="leading-6 text-warning">
        {t("hrisRequestsQueue.offline.description")}
      </p>
    </div>
  );
}
