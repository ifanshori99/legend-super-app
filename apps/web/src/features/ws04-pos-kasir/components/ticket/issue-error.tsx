import { useT } from "@/components/i18n";
import { ApiError } from "@/lib/api/errors";
import { TicketError } from "./ticket-error";

// Failed issue call: the server's error code picks a cashier-facing sentence.
// The server's own message is never shown; an unknown code gets the generic text.
const ISSUE_ERRORS = {
  TICKET_NOT_PAID: ["notPaid", "notPaidTitle", "notPaidHint"],
  TICKET_HOLD_LAPSED: ["holdLapsed", "holdLapsedTitle", "holdLapsedHint"],
  TICKET_NEEDS_CLOUD: ["needsCloud", "needsCloudTitle", "needsCloudHint"],
  TICKET_TRANSITION_INVALID: ["invalid", "invalidTitle", "invalidHint"],
  TICKET_PRODUCT_NOT_SELLABLE_AT_POS: [
    "notSellable",
    "notSellableTitle",
    "notSellableHint",
  ],
} as const;

export function IssueError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const t = useT();
  const known =
    error instanceof ApiError
      ? ISSUE_ERRORS[error.code as keyof typeof ISSUE_ERRORS]
      : undefined;
  const retryable = known === undefined || known[0] === "needsCloud";
  return (
    <TicketError
      error={error}
      title={
        known
          ? t(`posKasirTicket.step.errors.${known[1]}`)
          : t("posKasirTicket.step.issueErrorTitle")
      }
      hint={
        known
          ? t(`posKasirTicket.step.errors.${known[2]}`)
          : t("posKasirTicket.step.issueErrorHint")
      }
      onRetry={retryable ? onRetry : undefined}
    />
  );
}
