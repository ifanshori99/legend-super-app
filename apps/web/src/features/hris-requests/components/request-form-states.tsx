// The two screens that replace the request form (mockups sukses-mobile and
// offline-mobile): a confirmation with the pending request, and the "belum
// terkirim" card that keeps the request on screen until it is sent.
import { Link } from "@tanstack/react-router";
import { CircleCheck, Clock, TriangleAlert } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { MessageKey } from "@starter/shared/i18n";

export type RequestSummary = {
  /** Message key of the success sentence for this kind of request. */
  bodyKey: MessageKey;
  title: string;
  period: string;
  reason?: string;
};

export function RequestSuccess({
  summary,
  onAnother,
}: {
  summary: RequestSummary;
  onAnother: () => void;
}) {
  const t = useT();
  return (
    <div className="grid gap-4">
      <div
        role="status"
        className="flex items-start gap-2 rounded-container border-l-4 border-success bg-success-subtle px-4 py-3 text-success"
      >
        <CircleCheck className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="grid gap-0.5">
          <p className="font-semibold">
            {t("hrisRequestsEmployee.success.title")}
          </p>
          <p className="text-sm leading-5">{t(summary.bodyKey)}</p>
        </div>
      </div>
      <Card className="gap-3">
        <Badge tone="warning">
          <Clock aria-hidden="true" />
          {t("hrisRequestsEmployee.success.badge")}
        </Badge>
        <div className="grid gap-1">
          <p className="font-brand type-title">{summary.title}</p>
          <p className="text-sm leading-5 tabular">{summary.period}</p>
          {summary.reason && (
            <p className="text-sm leading-5 text-muted-foreground">
              {summary.reason}
            </p>
          )}
        </div>
        <p className="border-t pt-3 text-sm leading-5 text-muted-foreground">
          {t("hrisRequestsEmployee.success.followUp")}
        </p>
      </Card>
      <div className="grid gap-2">
        <Button asChild size="lg" className="w-full">
          <Link to="/karyawan/pengajuan">
            {t("hrisRequestsEmployee.success.toMine")}
          </Link>
        </Button>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={onAnother}
        >
          {t("hrisRequestsEmployee.success.another")}
        </Button>
      </div>
    </div>
  );
}

export function RequestOffline({
  retrying,
  onRetry,
  onDiscard,
}: {
  retrying: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  return (
    <div className="grid gap-4">
      <div
        role="alert"
        className="flex items-start gap-2 rounded-container border-l-4 border-warning bg-warning-subtle px-4 py-3 text-warning"
      >
        <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="grid gap-0.5">
          <p className="font-semibold">
            {t("hrisRequestsEmployee.offline.bannerTitle")}
          </p>
          <p className="text-sm leading-5">
            {t("hrisRequestsEmployee.offline.bannerBody")}
          </p>
        </div>
      </div>
      <Card className="gap-3">
        <div className="grid gap-1">
          <p className="font-brand type-title">
            {t("hrisRequestsEmployee.offline.cardTitle")}
          </p>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("hrisRequestsEmployee.offline.cardBody")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          loading={retrying}
          onClick={onRetry}
        >
          {retrying
            ? t("hrisRequestsEmployee.offline.retrying")
            : t("hrisRequestsEmployee.offline.retry")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          disabled={retrying}
          onClick={onDiscard}
        >
          {t("hrisRequestsEmployee.offline.discard")}
        </Button>
      </Card>
    </div>
  );
}
