// Service controls: the master switch and the Tanya AI switch, with a confirm
// before turning one off (the change stops new requests at once). The tool
// kill switches open in a sheet (tools-sheet.tsx).
import * as React from "react";
import { CircleCheck, CirclePause } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useGovernance, useUpdateGovernance } from "../hooks";
import { isOfflineError, saveErrorText, AdminCard } from "./shared";
import { ToolsSheet } from "./tools-sheet";

type Target = "master" | "askAi";

export function ServiceControls() {
  const t = useT();
  const toast = useToast();
  const governance = useGovernance(true);
  const update = useUpdateGovernance();
  const [confirm, setConfirm] = React.useState<Target | null>(null);
  const [toolsOpen, setToolsOpen] = React.useState(false);
  const [failure, setFailure] = React.useState<unknown>(null);

  if (governance.isPending) return <ControlsSkeleton />;
  if (governance.isError || !governance.data) {
    const offline = isOfflineError(governance.error);
    return (
      <AdminCard aria-labelledby="ai-controls-title">
        <h2 id="ai-controls-title" className="type-title">
          {t("aiAdmin.controls.title")}
        </h2>
        <ErrorState
          error={governance.error}
          title={t(
            offline ? "aiAdmin.error.offlineTitle" : "aiAdmin.error.title",
          )}
          description={t(
            offline ? "aiAdmin.error.offlineHint" : "aiAdmin.error.hint",
          )}
          onRetry={() => void governance.refetch()}
        />
      </AdminCard>
    );
  }

  const settings = governance.data.data;
  const masterOn = settings.aiEnabled || settings.mcpEnabled;
  const askAiOn = settings.aiEnabled;

  // Master switch: AI and MCP together. Tanya AI switch: the in-app chat only.
  const patchFor = (target: Target, on: boolean) =>
    target === "master" ? { aiEnabled: on, mcpEnabled: on } : { aiEnabled: on };

  const apply = (target: Target, on: boolean) => {
    setFailure(null);
    update.mutate(patchFor(target, on), {
      onSuccess: () => {
        setConfirm(null);
        toast({
          title: t(
            on ? "aiAdmin.controls.savedOn" : "aiAdmin.controls.savedOff",
          ),
          tone: "success",
        });
      },
      onError: (error) => setFailure(error),
    });
  };

  // Turning on is safe and immediate; turning off asks first.
  const request = (target: Target, on: boolean) => {
    if (on) apply(target, true);
    else {
      setFailure(null);
      setConfirm(target);
    }
  };

  return (
    <AdminCard aria-labelledby="ai-controls-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h2 id="ai-controls-title" className="type-title">
            {t("aiAdmin.controls.title")}
          </h2>
          <p className="max-w-2xl text-sm leading-5 text-muted-foreground">
            {t("aiAdmin.controls.description")}
          </p>
        </div>
        <Badge tone={masterOn ? "success" : "neutral"}>
          {masterOn ? (
            <CircleCheck aria-hidden="true" />
          ) : (
            <CirclePause aria-hidden="true" />
          )}
          {t(
            masterOn
              ? "aiAdmin.controls.statusOn"
              : "aiAdmin.controls.statusOff",
          )}
        </Badge>
      </div>

      <ul className="grid divide-y divide-border border-t border-border">
        <SwitchRow
          id="ai-master"
          title={t("aiAdmin.controls.master.title")}
          description={t("aiAdmin.controls.master.description")}
          checked={masterOn}
          busy={update.isPending}
          onCheckedChange={(on) => request("master", on)}
          stateLabel={t(
            masterOn
              ? "aiAdmin.controls.switchOn"
              : "aiAdmin.controls.switchOff",
          )}
        />
        <SwitchRow
          id="ai-ask"
          title={t("aiAdmin.controls.askAi.title")}
          description={t("aiAdmin.controls.askAi.description")}
          checked={askAiOn}
          busy={update.isPending}
          onCheckedChange={(on) => request("askAi", on)}
          stateLabel={t(
            askAiOn
              ? "aiAdmin.controls.switchOn"
              : "aiAdmin.controls.switchOff",
          )}
        />
        <li className="flex items-center justify-between gap-4 py-3">
          <div className="grid min-w-0 gap-0.5">
            <h3 className="text-base leading-6 font-semibold">
              {t("aiAdmin.controls.tools.title")}
            </h3>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("aiAdmin.controls.tools.description")}
            </p>
          </div>
          <Button variant="outline" onClick={() => setToolsOpen(true)}>
            {t("aiAdmin.controls.tools.manage")}
          </Button>
        </li>
      </ul>

      {failure !== null && confirm === null && (
        <p role="alert" className="text-sm leading-5 font-medium text-danger">
          {saveErrorText(t, failure)}
        </p>
      )}

      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !update.isPending) setConfirm(null);
        }}
      >
        <DialogContent>
          {confirm !== null && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {t(
                    confirm === "master"
                      ? "aiAdmin.controls.confirmMaster.title"
                      : "aiAdmin.controls.confirmAskAi.title",
                  )}
                </DialogTitle>
                <DialogDescription>
                  {t(
                    confirm === "master"
                      ? "aiAdmin.controls.confirmMaster.body"
                      : "aiAdmin.controls.confirmAskAi.body",
                  )}
                </DialogDescription>
              </DialogHeader>
              {failure !== null && (
                <p
                  role="alert"
                  className="text-sm leading-5 font-medium text-danger"
                >
                  {saveErrorText(t, failure)}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setConfirm(null)}
                  disabled={update.isPending}
                >
                  {t("aiAdmin.controls.cancel")}
                </Button>
                <Button
                  variant="destructive"
                  loading={update.isPending}
                  onClick={() => apply(confirm, false)}
                >
                  {t(
                    confirm === "master"
                      ? "aiAdmin.controls.confirmMaster.confirm"
                      : "aiAdmin.controls.confirmAskAi.confirm",
                  )}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ToolsSheet open={toolsOpen} onOpenChange={setToolsOpen} />
    </AdminCard>
  );
}

function SwitchRow({
  id,
  title,
  description,
  checked,
  busy,
  stateLabel,
  onCheckedChange,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  busy: boolean;
  stateLabel: string;
  onCheckedChange: (on: boolean) => void;
}) {
  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <div className="grid min-w-0 gap-0.5">
        <h3 id={`${id}-title`} className="text-base leading-6 font-semibold">
          {title}
        </h3>
        <p
          id={`${id}-hint`}
          className="text-sm leading-5 text-muted-foreground"
        >
          {description}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-sm leading-5 font-medium text-muted-foreground">
          {stateLabel}
        </span>
        <Switch
          checked={checked}
          aria-busy={busy || undefined}
          onCheckedChange={(on) => {
            if (!busy) onCheckedChange(on);
          }}
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-hint`}
        />
      </div>
    </li>
  );
}

function ControlsSkeleton() {
  return (
    <AdminCard aria-busy="true">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </AdminCard>
  );
}
