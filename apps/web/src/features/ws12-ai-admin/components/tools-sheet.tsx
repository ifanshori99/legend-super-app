// "Kelola tool": every catalog tool with its kill switch. A toggle sends the
// whole disabledToolCodes list (the API replaces it), rebuilt from this list.
import * as React from "react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useGovernanceTools, useUpdateGovernance } from "../hooks";
import type { AiToolCode } from "@starter/shared/ai";
import { disabledCodesAfterToggle } from "../logic";
import { isOfflineError, saveErrorText } from "./shared";

export function ToolsSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const tools = useGovernanceTools(open);
  const update = useUpdateGovernance();
  const [pendingCode, setPendingCode] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<unknown>(null);

  const list = tools.data?.data ?? [];

  const toggle = (code: string, enabled: boolean) => {
    setFailure(null);
    setPendingCode(code);
    update.mutate(
      {
        disabledToolCodes: disabledCodesAfterToggle(
          list,
          code,
          enabled,
        ) as AiToolCode[],
      },
      {
        onSuccess: () =>
          toast({
            title: t(
              enabled
                ? "aiAdmin.toolsSheet.savedOn"
                : "aiAdmin.toolsSheet.savedOff",
            ),
            tone: "success",
          }),
        onError: (error) => setFailure(error),
        onSettled: () => setPendingCode(null),
      },
    );
  };

  const enabledCount = list.filter((tool) => tool.isEnabled).length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(32rem,calc(100%-1.5rem))]">
        <SheetHeader className="pr-10">
          <SheetTitle>{t("aiAdmin.toolsSheet.title")}</SheetTitle>
          <SheetDescription>
            {t("aiAdmin.toolsSheet.description")}
          </SheetDescription>
        </SheetHeader>

        {tools.isPending ? (
          <div className="grid gap-3" aria-busy="true">
            {[0, 1, 2, 3, 4].map((n) => (
              <Skeleton key={n} className="h-16 w-full" />
            ))}
          </div>
        ) : tools.isError ? (
          <ErrorState
            error={tools.error}
            title={t(
              isOfflineError(tools.error)
                ? "aiAdmin.error.offlineTitle"
                : "aiAdmin.toolsSheet.errorTitle",
            )}
            description={t(
              isOfflineError(tools.error)
                ? "aiAdmin.error.offlineHint"
                : "aiAdmin.toolsSheet.errorHint",
            )}
            onRetry={() => void tools.refetch()}
          />
        ) : list.length === 0 ? (
          <EmptyState
            title={t("aiAdmin.toolsSheet.emptyTitle")}
            description={t("aiAdmin.toolsSheet.emptyHint")}
          />
        ) : (
          <>
            <p
              className="text-sm leading-5 text-muted-foreground"
              aria-live="polite"
            >
              {t("aiAdmin.toolsSheet.count", {
                enabled: enabledCount,
                total: list.length,
              })}
            </p>
            {failure !== null && (
              <p
                role="alert"
                className="text-sm leading-5 font-medium text-danger"
              >
                {saveErrorText(t, failure)}
              </p>
            )}
            <ul className="grid divide-y divide-border border-y border-border">
              {list.map((tool) => (
                <li
                  key={tool.code}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <div className="grid min-w-0 gap-1">
                    <span
                      id={`tool-${tool.code}`}
                      className="text-base leading-6 font-semibold"
                    >
                      {tool.titleId}
                    </span>
                    <span className="flex flex-wrap items-center gap-2 text-sm leading-5 text-muted-foreground">
                      <span className="tabular">{tool.code}</span>
                      <Badge
                        tone={tool.kind === "write" ? "warning" : "neutral"}
                      >
                        {t(
                          tool.kind === "write"
                            ? "aiAdmin.toolsSheet.kindWrite"
                            : "aiAdmin.toolsSheet.kindRead",
                        )}
                      </Badge>
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-sm leading-5 font-medium text-muted-foreground">
                      {t(
                        tool.isEnabled
                          ? "aiAdmin.toolsSheet.enabled"
                          : "aiAdmin.toolsSheet.disabled",
                      )}
                    </span>
                    <Switch
                      checked={tool.isEnabled}
                      disabled={pendingCode !== null}
                      aria-labelledby={`tool-${tool.code}`}
                      aria-busy={pendingCode === tool.code || undefined}
                      onCheckedChange={(on) => toggle(tool.code, on)}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
