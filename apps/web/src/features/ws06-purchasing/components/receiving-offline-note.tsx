// Offline note shared by the receiving lists (PRD: every list has a loading,
// empty and error state, and the offline case is named). The banner slot above
// the content is filled by another bead, so this stays a local note.
import { useT } from "@/components/i18n";
import { useOnline } from "@/lib/use-online";

export function ReceivingOfflineNote() {
  const t = useT();
  const online = useOnline();
  if (online) return null;
  return (
    <p
      role="status"
      className="rounded-container border bg-warning-subtle px-card py-2 text-sm font-medium text-warning"
    >
      {t("inventoryReceiving.offline")}
    </p>
  );
}
