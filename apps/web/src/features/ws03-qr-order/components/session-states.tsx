// Full-width states of the table journey: unknown QR, menu load failure, and
// an ended session (ORD-04).
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, QrCode, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { useTableJourney } from "../context";
import { QrTopBar, qrRoundIcon } from "./glass/qr-primitives";
import { Notice } from "./notice";

/** Paper panel for the empty / error states that sit on the ivory canvas. */
const STATE_PAPER = "rounded-qr-media bg-card";

/** 44px round link back to the menu, the leading control of QrTopBar. */
export function QrBackLink() {
  const t = useT();
  const { qrToken } = useTableJourney();
  return (
    <Link
      to="/t/$token"
      params={{ token: qrToken }}
      aria-label={t("qrGlass.table.backToMenu")}
      className={qrRoundIcon}
    >
      <ArrowLeft aria-hidden="true" />
    </Link>
  );
}

/**
 * Secondary table page: glass top bar with the back link and the page title,
 * then the content in a readable column (~48rem on lg, where the frame header
 * carries the nav). Put QrFooter last in `children`.
 */
export function QrSubPage({
  title,
  children,
  className,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto grid w-full max-w-3xl gap-4", className)}>
      <QrTopBar title={title} leading={<QrBackLink />} />
      {children}
    </div>
  );
}

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
        className={STATE_PAPER}
        title={t("qrMenu.states.notFoundTitle")}
        description={t("qrMenu.states.notFoundHint")}
        action={
          <Button type="button" onClick={onRetry}>
            {t("qrMenu.states.retry")}
          </Button>
        }
      />
    );
  if (error && (error.status === 0 || error.code === "NETWORK_ERROR"))
    return (
      <ErrorState
        className={STATE_PAPER}
        title={t("qrMenu.states.offlineTitle")}
        description={t("qrMenu.states.offlineHint")}
        onRetry={onRetry}
      />
    );
  return (
    <ErrorState
      className={STATE_PAPER}
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
      className={STATE_PAPER}
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
