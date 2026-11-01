// Runner assignment for one expo order (PRD §3 F12 "menugaskan runner").
// A dialog, not a select: the names are the decision, and a 60px target per row
// is what a tablet on the pass can hit. The dialog never decides who may run —
// the list is what the API offers for this outlet.
import { Check, TriangleAlert } from "lucide-react";
import type { ExpoRunner, ExpoTicket } from "@starter/shared/kitchen";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { expoTargetLabel } from "./target-label.ts";

export function RunnerPicker({
  open,
  onOpenChange,
  ticket,
  runners,
  runnersPending,
  runnersFailed,
  onRetryRunners,
  assignedRunnerId,
  onPick,
  picking,
  pickError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticket: ExpoTicket | null;
  runners: readonly ExpoRunner[];
  runnersPending: boolean;
  runnersFailed: boolean;
  onRetryRunners: () => void;
  assignedRunnerId: string | null;
  onPick: (runnerId: ExpoRunner["userId"]) => void;
  picking: boolean;
  pickError: string | null;
}) {
  const t = useT();
  const target = ticket ? expoTargetLabel(ticket, t) : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("expo.runnerDialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("expo.runnerDialogHint", { target })}
          </DialogDescription>
        </DialogHeader>

        {pickError !== null && (
          <p
            role="alert"
            className="inline-flex items-start gap-2 text-sm font-medium text-danger"
          >
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {pickError}
          </p>
        )}

        {runnersPending ? (
          <div className="grid gap-2" aria-busy="true">
            <span className="sr-only">{t("common.loading")}</span>
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-control w-full" />
            ))}
          </div>
        ) : runnersFailed ? (
          <ErrorState
            title={t("expo.runnerError")}
            description={t("expo.runnerErrorHint")}
            onRetry={onRetryRunners}
          />
        ) : runners.length === 0 ? (
          <EmptyState
            title={t("expo.runnerEmpty")}
            description={t("expo.runnerEmptyHint")}
          />
        ) : (
          <ul className="grid gap-2">
            {runners.map((runner) => {
              const selected = runner.userId === assignedRunnerId;
              return (
                <li key={runner.userId}>
                  <Button
                    variant="outline"
                    className={cn(
                      "h-control w-full justify-between px-4",
                      selected && "border-primary bg-accent",
                    )}
                    aria-pressed={selected}
                    disabled={picking}
                    onClick={() => onPick(runner.userId)}
                  >
                    <span className="truncate">{runner.name}</span>
                    {selected && <Check aria-hidden="true" />}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={picking}
          >
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
