import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { isContractPending } from "../../hooks";
import { Notice } from "../shared";

// A failed call in words the cashier can act on. The server's own message is
// never shown: a missing contract gets its own text, everything else a generic
// title (from the caller) plus a recovery step. `onRetry` adds a retry button.
export function TicketError({
  error,
  title,
  hint,
  onRetry,
}: {
  error: unknown;
  title: string;
  /** Recovery step; defaults to "check the connection and try again". */
  hint?: string;
  onRetry?: () => void;
}) {
  const t = useT();
  const pending = isContractPending(error);
  return (
    <div className="grid justify-items-start gap-3">
      <Notice
        tone={pending ? "warning" : "danger"}
        title={pending ? t("posKasirTicket.error.pendingTitle") : title}
        className="w-full"
      >
        {pending
          ? t("posKasirTicket.error.pendingHint")
          : (hint ?? t("posKasirTicket.error.hint"))}
      </Notice>
      {onRetry && !pending && (
        <Button type="button" variant="outline" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}
