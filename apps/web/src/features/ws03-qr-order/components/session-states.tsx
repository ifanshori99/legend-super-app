// Full-width states of the table journey: unknown QR, menu load failure, and
// an ended session (ORD-04).
import { QrCode, TriangleAlert } from "lucide-react";
import { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { useTableJourney } from "../context";
import { Notice } from "./notice";

export function MenuLoadState({
  error,
  onRetry,
}: {
  error: ApiError | null;
  onRetry: () => void;
}) {
  const t = useT();
  if (error && (error.status === 404 || error.status === 400))
    return (
      <EmptyState
        icon={QrCode}
        title={t("qrMenu.states.notFoundTitle")}
        description={t("qrMenu.states.notFoundHint")}
      />
    );
  return (
    <ErrorState
      title={t("qrMenu.states.errorTitle")}
      description={t("qrMenu.states.errorHint")}
      onRetry={onRetry}
    />
  );
}

/** Shown in place of ordering screens once the table session has ended. */
export function SessionEnded() {
  const t = useT();
  const { startOver } = useTableJourney();
  return (
    <EmptyState
      icon={TriangleAlert}
      title={t("qrMenu.session.endedTitle")}
      description={t("qrMenu.session.endedHint")}
      action={
        <Button type="button" onClick={startOver}>
          {t("qrMenu.session.startOver")}
        </Button>
      }
    />
  );
}

/** Open-bill zone: a waiter confirms the table before the first order. */
export function PendingConfirmationNotice() {
  const t = useT();
  const { awaitingConfirmation } = useTableJourney();
  if (!awaitingConfirmation) return null;
  return (
    <Notice tone="waiting" title={t("qrMenu.session.pendingTitle")}>
      {t("qrMenu.session.pendingHint")}
    </Notice>
  );
}
