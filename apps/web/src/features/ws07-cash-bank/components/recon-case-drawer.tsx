// Case drawer (ACC-04): the case detail the cases table opens. Actions follow
// reconciliationCaseActions(status): start, reassign, resolve. Write-off needs
// an adjustment journal from the journal module, so it is explained instead of
// offered with a fake id.
import * as React from "react";
import { PlayCircle } from "lucide-react";
import type { ReconciliationCase } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { useAssignablePeople } from "@/features/ws01-access/people";
import {
  CASE_TYPE_KEYS,
  REF_TYPE_KEYS,
  caseErrorKey,
  formatDateTime,
  reconciliationCaseActions,
  shortId,
} from "../lib";
import { useCaseAction, useReconciliationCase } from "../hooks";
import { ReconciliationCaseStatusBadge } from "./status-badges";

export function ReconciliationCaseDrawer({
  caseId,
  open,
  onOpenChange,
  canWrite,
}: {
  caseId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canWrite: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(30rem,calc(100%-2rem))]">
        {caseId ? (
          <CaseDetail
            caseId={caseId}
            canWrite={canWrite}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function CaseDetail({
  caseId,
  canWrite,
  onClose,
}: {
  caseId: string;
  canWrite: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const query = useReconciliationCase(caseId);
  const action = useCaseAction();
  const people = useAssignablePeople();
  const [ownerId, setOwnerId] = React.useState("");
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const peopleOptions = people.data?.people ?? [];
  const peopleUnavailable = people.data?.unavailable ?? false;

  const run = (
    payload: Parameters<typeof action.mutate>[0]["action"],
    successKey:
      | "accounting.cash.recon.drawer.startDone"
      | "accounting.cash.recon.drawer.reassignDone"
      | "accounting.cash.recon.drawer.resolveDone",
    closeAfter = false,
  ) => {
    setError(null);
    action.mutate(
      { caseId, action: payload },
      {
        onSuccess: () => {
          toast({ title: t(successKey), tone: "success" });
          if (closeAfter) onClose();
        },
        onError: (mutationError) => {
          setError(
            mutationError instanceof ApiError
              ? t(caseErrorKey(mutationError.code))
              : t("accounting.cash.recon.drawer.failed"),
          );
        },
      },
    );
  };

  if (query.isPending)
    return (
      <>
        <SheetHeader>
          <SheetTitle>{t("accounting.cash.recon.drawer.title")}</SheetTitle>
        </SheetHeader>
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">
            {t("accounting.cash.recon.drawer.loading")}
          </span>
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </>
    );

  if (query.isError || !query.data)
    return (
      <>
        <SheetHeader>
          <SheetTitle>{t("accounting.cash.recon.drawer.title")}</SheetTitle>
        </SheetHeader>
        <ErrorState
          title={t("accounting.cash.recon.drawer.error")}
          onRetry={() => {
            void query.refetch();
          }}
        />
      </>
    );

  const row = query.data;
  const actions = reconciliationCaseActions(row.status);
  const effectiveOwner = ownerId || row.ownerId || peopleOptions[0]?.id || "";
  const done = row.status === "resolved" || row.status === "written_off";

  return (
    <>
      <SheetHeader>
        <SheetTitle>{t("accounting.cash.recon.drawer.title")}</SheetTitle>
        <SheetDescription>
          {t(CASE_TYPE_KEYS[row.type])} · {shortId(row.id)}
        </SheetDescription>
      </SheetHeader>

      <div className="flex flex-wrap items-center gap-2">
        <ReconciliationCaseStatusBadge status={row.status} />
      </div>

      <dl className="grid gap-2 rounded-container border-(length:--border-w) bg-surface-2 p-card text-sm">
        <DetailRow label={t("accounting.cash.recon.drawer.difference")}>
          <Money amount={row.differenceIdr} />
        </DetailRow>
        <DetailRow label={t("accounting.cash.recon.drawer.pic")}>
          {personName(row, peopleOptions, t)}
        </DetailRow>
        <DetailRow label={t("accounting.cash.recon.drawer.due")}>
          <span className="tabular">{formatDateTime(row.dueAt)}</span>
        </DetailRow>
        <DetailRow label={t("accounting.cash.recon.drawer.openedAt")}>
          <span className="tabular">{formatDateTime(row.openedAt)}</span>
        </DetailRow>
        {done && row.resolvedAt && (
          <DetailRow label={t("accounting.cash.recon.drawer.resolvedAt")}>
            <span className="tabular">{formatDateTime(row.resolvedAt)}</span>
          </DetailRow>
        )}
        {row.resolutionNote && (
          <DetailRow label={t("accounting.cash.recon.drawer.note")}>
            <span className="whitespace-pre-wrap">{row.resolutionNote}</span>
          </DetailRow>
        )}
      </dl>

      <section className="grid gap-1.5">
        <h3 className="text-sm font-semibold">
          {t("accounting.cash.recon.drawer.refs")}
        </h3>
        <ul className="grid gap-1 text-sm">
          {row.refs.map((ref) => (
            <li
              key={`${ref.type}:${ref.id}`}
              className="flex items-center justify-between gap-2 rounded-md bg-surface-2 px-2 py-1"
            >
              <span>{t(REF_TYPE_KEYS[ref.type])}</span>
              <span className="tabular text-muted-foreground">
                {shortId(ref.id)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {error && (
        <p role="alert" className="text-sm leading-5 font-medium text-danger">
          {error}
        </p>
      )}

      {canWrite && actions.length > 0 && (
        <div className="grid gap-4 border-t border-border pt-4">
          {actions.includes("start") && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={action.isPending}
              onClick={() =>
                run({ type: "start" }, "accounting.cash.recon.drawer.startDone")
              }
            >
              <PlayCircle aria-hidden="true" />
              {t("accounting.cash.recon.drawer.start")}
            </Button>
          )}

          {actions.includes("reassign") &&
            (peopleUnavailable ? (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("accounting.cash.recon.drawer.noPeople")}
              </p>
            ) : (
              <div className="grid gap-2">
                <FormField
                  // FormField's Slot would put the id on a wrapper; the Select
                  // root renders no DOM, so the trigger carries the same id.
                  id="recon-case-reassign"
                  label={t("accounting.cash.recon.drawer.reassign")}
                  hint={t("accounting.cash.recon.drawer.reassignHint")}
                  required
                >
                  <Select value={effectiveOwner} onValueChange={setOwnerId}>
                    <SelectTrigger
                      id="recon-case-reassign"
                      className="h-control-sm"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {peopleOptions.map((person) => (
                        <SelectItem key={person.id} value={person.id}>
                          {person.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="justify-self-start"
                  loading={action.isPending}
                  disabled={
                    effectiveOwner === "" || effectiveOwner === row.ownerId
                  }
                  onClick={() =>
                    run(
                      {
                        type: "reassign",
                        ownerId:
                          effectiveOwner as ReconciliationCase["ownerId"],
                      },
                      "accounting.cash.recon.drawer.reassignDone",
                    )
                  }
                >
                  {t("accounting.cash.recon.drawer.reassignSubmit")}
                </Button>
              </div>
            ))}

          {actions.includes("resolve") && (
            <div className="grid gap-2">
              <FormField
                label={t("accounting.cash.recon.drawer.resolveLabel")}
                hint={t("accounting.cash.recon.drawer.resolveHint")}
                required
              >
                <Textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={3}
                  maxLength={500}
                />
              </FormField>
              <Button
                type="button"
                size="sm"
                loading={action.isPending}
                disabled={note.trim() === ""}
                onClick={() =>
                  run(
                    { type: "resolve", note: note.trim() },
                    "accounting.cash.recon.drawer.resolveDone",
                    true,
                  )
                }
              >
                {t("accounting.cash.recon.drawer.resolveSubmit")}
              </Button>
            </div>
          )}

          {!done && (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("accounting.cash.recon.drawer.writeOffUnavailable")}
            </p>
          )}
        </div>
      )}

      <SheetFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("common.close")}
        </Button>
      </SheetFooter>
    </>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function personName(
  row: ReconciliationCase,
  people: readonly { id: string; name: string }[],
  t: ReturnType<typeof useT>,
): string {
  const hit = people.find((person) => person.id === row.ownerId);
  return (
    hit?.name ??
    t("accounting.cash.recon.cases.unknownUser", {
      id: shortId(row.ownerId),
    })
  );
}
