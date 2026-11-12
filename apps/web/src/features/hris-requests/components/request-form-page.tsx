// "/karyawan/pengajuan/baru" — the employee's request form (legend-ydf2 HR-05):
// tabs for tukar/ganti shift, cuti/izin and lembur on the Hangat density.
// This page owns the three create hooks, so a request that could not be sent
// (offline) stays on screen with "Coba lagi" even though its form is gone.
import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { businessDateOf, type OutletId } from "@starter/shared/core";
import type {
  EmployeeId,
  LeaveTypeId,
  ShiftAssignmentId,
} from "@starter/shared/hris";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useCreateLeaveRequest,
  useCreateOvertimeRequest,
  useCreateShiftSwap,
} from "@/features/hris-requests/hooks";
import type { AreaAccess } from "@/lib/areas/access";
import { newIdempotencyKey } from "@/lib/idempotency";
import { useOutletClock } from "@/lib/tenant-context";
import { useOnline } from "@/lib/use-online";
import { RequestFormLeave, type LeaveSubmit } from "./request-form-leave.tsx";
import {
  isNetworkFailure,
  allowedTabs,
  isFormTab,
  keyForDraft,
  pickTab,
  type DraftKey,
  type FormTab,
} from "./request-form-logic.ts";
import {
  RequestFormOvertime,
  type OvertimeSubmit,
} from "./request-form-overtime.tsx";
import {
  RequestOffline,
  RequestSuccess,
  type RequestSummary,
} from "./request-form-states.tsx";
import { RequestFormSwap, type SwapSubmit } from "./request-form-swap.tsx";

type Request =
  | ({ type: "swap" } & SwapSubmit)
  | ({ type: "leave" } & LeaveSubmit)
  | ({ type: "overtime" } & OvertimeSubmit);

type Phase =
  | { name: "form" }
  | { name: "sent"; summary: RequestSummary }
  | { name: "offline"; request: Request };

const TITLE_KEY = {
  swap: "hrisRequestsEmployee.form.titleSwap",
  leave: "hrisRequestsEmployee.form.titleLeave",
  overtime: "hrisRequestsEmployee.form.titleOvertime",
} as const;

export function RequestFormPage({
  access,
  initialTab = "swap",
}: {
  access: AreaAccess;
  initialTab?: FormTab;
}) {
  const t = useT();
  const online = useOnline();
  const { clock } = useOutletClock();
  const year = Number(businessDateOf(new Date(), clock).slice(0, 4));
  // Tabs without the permission are hidden (the API still checks on submit).
  const tabs = allowedTabs(access.permissions);
  const [wantedTab, setTab] = useState<FormTab>(initialTab);
  const tab = pickTab(wantedTab, tabs);
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const [failed, setFailed] = useState(false);
  const swap = useCreateShiftSwap();
  const leave = useCreateLeaveRequest();
  const overtime = useCreateOvertimeRequest();
  // One key per draft, kept across offline retries (see `keyForDraft`).
  const draftKey = useRef<DraftKey | null>(null);
  const busy = swap.isPending || leave.isPending || overtime.isPending;

  function send(request: Request) {
    setFailed(false);
    if (!online) {
      setPhase({ name: "offline", request });
      return;
    }
    draftKey.current = keyForDraft(
      draftKey.current,
      request.type,
      request.payload,
      newIdempotencyKey,
    );
    const idempotencyKey = draftKey.current.key;
    const options = {
      onSuccess: () => {
        draftKey.current = null;
        setPhase({ name: "sent", summary: request.summary });
      },
      onError: (error: unknown) => {
        if (isNetworkFailure(error, navigator.onLine)) {
          setPhase({ name: "offline", request });
        } else {
          setFailed(true);
          setTab(request.type);
          setPhase({ name: "form" });
        }
      },
    };
    if (request.type === "swap")
      swap.mutate(
        {
          ...request.payload,
          fromAssignmentId: request.payload
            .fromAssignmentId as ShiftAssignmentId,
          toEmployeeId: request.payload.toEmployeeId as EmployeeId,
          toAssignmentId: request.payload
            .toAssignmentId as ShiftAssignmentId | null,
          outletId: (request.payload.outletId || undefined) as
            OutletId | undefined,
          idempotencyKey,
        },
        options,
      );
    else if (request.type === "leave")
      leave.mutate(
        {
          ...request.payload,
          leaveTypeId: request.payload.leaveTypeId as LeaveTypeId,
          idempotencyKey,
        },
        options,
      );
    else
      overtime.mutate(
        {
          ...request.payload,
          outletId: (request.payload.outletId || undefined) as
            OutletId | undefined,
          idempotencyKey,
        },
        options,
      );
  }

  function reset() {
    setFailed(false);
    setPhase({ name: "form" });
  }

  if (tab === null) return null;
  const showingForm = phase.name === "form";

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
          <Link to="/karyawan/pengajuan">
            <ChevronLeft aria-hidden="true" />
            {t("hrisRequestsEmployee.form.backToMine")}
          </Link>
        </Button>
        <header className="grid gap-1">
          <h1 className="font-brand type-display-xl">
            {showingForm
              ? t(TITLE_KEY[tab])
              : t("hrisRequestsEmployee.form.mineTitle")}
          </h1>
          <p className="text-sm leading-5 text-muted-foreground">
            {showingForm
              ? t("hrisRequestsEmployee.form.subtitle")
              : t("hrisRequestsEmployee.form.mineSubtitle")}
          </p>
        </header>
      </div>

      {phase.name === "sent" ? (
        <RequestSuccess summary={phase.summary} onAnother={reset} />
      ) : phase.name === "offline" ? (
        <RequestOffline
          retrying={busy}
          onRetry={() => send(phase.request)}
          onDiscard={reset}
        />
      ) : (
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (isFormTab(value)) {
              setTab(value);
              setFailed(false);
            }
          }}
          className="gap-4"
        >
          <TabsList aria-label={t("hrisRequestsEmployee.form.tabsLabel")}>
            {tabs.includes("swap") && (
              <TabsTrigger value="swap">
                {t("hrisRequestsEmployee.form.tabSwap")}
              </TabsTrigger>
            )}
            {tabs.includes("leave") && (
              <TabsTrigger value="leave">
                {t("hrisRequestsEmployee.form.tabLeave")}
              </TabsTrigger>
            )}
            {tabs.includes("overtime") && (
              <TabsTrigger value="overtime">
                {t("hrisRequestsEmployee.form.tabOvertime")}
              </TabsTrigger>
            )}
          </TabsList>
          <Card>
            {tabs.includes("swap") && (
              <TabsContent value="swap" className="pt-0">
                <RequestFormSwap
                  busy={busy}
                  failed={failed}
                  onSubmit={(request) => send({ type: "swap", ...request })}
                />
              </TabsContent>
            )}
            {tabs.includes("leave") && (
              <TabsContent value="leave" className="pt-0">
                <RequestFormLeave
                  busy={busy}
                  failed={failed}
                  year={year}
                  onSubmit={(request) => send({ type: "leave", ...request })}
                />
              </TabsContent>
            )}
            {tabs.includes("overtime") && (
              <TabsContent value="overtime" className="pt-0">
                <RequestFormOvertime
                  busy={busy}
                  failed={failed}
                  onSubmit={(request) => send({ type: "overtime", ...request })}
                />
              </TabsContent>
            )}
          </Card>
        </Tabs>
      )}
    </div>
  );
}
