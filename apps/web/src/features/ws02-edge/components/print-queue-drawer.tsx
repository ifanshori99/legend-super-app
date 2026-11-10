// Print queue drawer with reprint (PRD v1.7 §3 F5 "Print Agent": antrean
// cetak, cetak ulang, peringatan printer offline). Shared by POS/KDS screens
// as-is: the trigger owns the drawer state, so a shell only renders
// <PrintQueueButton />.
import { useState } from "react";
import { CircleAlert, CircleCheck, Clock, Printer } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import type { PrintJob } from "@starter/shared/edge";
import {
  useEdgeDevices,
  usePrintQueue,
  useReprintPrintJob,
  useRetryPrintJob,
} from "../hooks.ts";
import {
  formatClock,
  PRINT_KIND_LABEL,
  PRINT_STATUS_LABEL,
  printJobActions,
  summarizePrintJobs,
} from "../logic.ts";

const STATUS_BADGE = {
  queued: { tone: "neutral", Icon: Clock },
  printing: { tone: "info", Icon: Printer },
  printed: { tone: "success", Icon: CircleCheck },
  failed: { tone: "danger", Icon: CircleAlert },
} as const;

function PrintStatusBadge({ status }: { status: PrintJob["status"] }) {
  const t = useT();
  const { tone, Icon } = STATUS_BADGE[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(PRINT_STATUS_LABEL[status])}
    </Badge>
  );
}

export function PrintQueueButton({ className }: { className?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        className={className}
        onClick={() => setOpen(true)}
      >
        <Printer aria-hidden="true" />
        {t("edge.print.open")}
      </Button>
      <PrintQueueDrawer open={open} onOpenChange={setOpen} />
    </>
  );
}

export function PrintQueueDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const queue = usePrintQueue(open);
  const devices = useEdgeDevices();
  const reprint = useReprintPrintJob();
  const retry = useRetryPrintJob();

  const printerLabel = (printerId: string) =>
    devices.data?.data.find((device) => device.id === printerId)?.label ??
    t("edge.print.printerMissing");

  const failed = (error: unknown) =>
    toast({
      title: t("edge.print.actionFailed"),
      description: error instanceof ApiError ? error.message : undefined,
      tone: "danger",
    });

  const onRetry = (printJobId: string) =>
    retry.mutate(printJobId, {
      onSuccess: () =>
        toast({ title: t("edge.print.retryDone"), tone: "success" }),
      onError: failed,
    });

  const onReprint = (printJobId: string) =>
    reprint.mutate(printJobId, {
      onSuccess: () =>
        toast({ title: t("edge.print.reprintDone"), tone: "success" }),
      onError: failed,
    });

  const summary = summarizePrintJobs(queue.jobs);
  const busy =
    queue.isPending || (queue.isFetching && !queue.isFetchingNextPage);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 sm:w-[min(32rem,calc(100%-3rem))]"
      >
        <SheetHeader className="border-b-(length:--border-w) p-card">
          <SheetTitle>{t("edge.print.title")}</SheetTitle>
          <SheetDescription>{t("edge.print.description")}</SheetDescription>
        </SheetHeader>

        <div
          aria-busy={busy || undefined}
          className="min-h-0 flex-1 overflow-y-auto px-card"
        >
          {queue.isPending && (
            <div className="grid gap-3 py-4">
              <span className="sr-only">{t("common.loading")}</span>
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-16" />
              ))}
            </div>
          )}

          {queue.isError && (
            <ErrorState
              error={queue.error}
              title={t("state.errorTitle")}
              description={t("state.errorHint")}
              onRetry={() => void queue.refetch()}
            />
          )}

          {!queue.isPending && !queue.isError && queue.jobs.length === 0 && (
            <EmptyState
              icon={Printer}
              title={t("edge.print.emptyTitle")}
              description={t("edge.print.emptyHint")}
            />
          )}

          {queue.jobs.length > 0 && (
            <>
              <p className="py-2 text-sm text-muted-foreground tabular">
                {t("edge.print.count", { count: queue.jobs.length })}
                {summary.failed > 0 &&
                  ` · ${t("edge.print.failedCount", { count: summary.failed })}`}
              </p>
              <ul className="divide-y divide-border">
                {queue.jobs.map((job) => {
                  const actions = printJobActions(job);
                  const sentAt = formatClock(job.createdAt);
                  return (
                    <li
                      key={job.id}
                      className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:gap-3"
                    >
                      <div className="grid min-w-0 flex-1 gap-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-semibold">
                            {t(PRINT_KIND_LABEL[job.kind])}
                          </span>
                          <PrintStatusBadge status={job.status} />
                          {job.reprintOf && (
                            <Badge tone="neutral">
                              {t("edge.print.reprintTag")}
                            </Badge>
                          )}
                        </div>
                        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                          <span className="inline-flex min-w-0 items-center gap-1.5">
                            <Printer
                              className="size-4 shrink-0"
                              aria-hidden="true"
                            />
                            <span className="truncate">
                              {printerLabel(job.printerId)}
                            </span>
                          </span>
                          {sentAt && (
                            <span className="tabular">
                              {t("edge.print.sentAt", { time: sentAt })}
                            </span>
                          )}
                        </p>
                      </div>
                      {(actions.canRetry || actions.canReprint) && (
                        <div className="flex shrink-0 gap-2 sm:ml-auto">
                          {actions.canRetry && (
                            <Button
                              size="sm"
                              variant="outline"
                              loading={
                                retry.isPending && retry.variables === job.id
                              }
                              onClick={() => onRetry(job.id)}
                            >
                              {t("edge.print.retry")}
                            </Button>
                          )}
                          {actions.canReprint && (
                            <Button
                              size="sm"
                              variant="outline"
                              loading={
                                reprint.isPending &&
                                reprint.variables === job.id
                              }
                              onClick={() => onReprint(job.id)}
                            >
                              {t("edge.print.reprint")}
                            </Button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {queue.hasNextPage && (
                <div className="pb-4">
                  <Button
                    variant="outline"
                    className="w-full"
                    loading={queue.isFetchingNextPage}
                    onClick={() => void queue.fetchNextPage()}
                  >
                    {t("edge.print.loadMore")}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
