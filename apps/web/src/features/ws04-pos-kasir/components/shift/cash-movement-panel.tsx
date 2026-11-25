import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useOutletClock } from "@/lib/tenant-context";
import { Money } from "@/components/ui/money";
import { useCashMovements, useRecordCashMovement } from "../../shift-hooks";
import type { CashMovement } from "../../types";
import { PosPanel, StateBlock, parseDigits } from "../shared";
import { formatShiftTime } from "./shift-format";
import { ActionError } from "./shift-parts";

type FormType = "cash_in" | "cash_out";

const MIN_REASON_LENGTH = 4;

function MovementRow({ movement }: { movement: CashMovement }) {
  const t = useT();
  const { timeZone } = useOutletClock();
  const type = t(
    movement.type === "cash_in"
      ? "posKasirShift.movement.typeCashIn"
      : movement.type === "cash_out"
        ? "posKasirShift.movement.typeCashOut"
        : "posKasirShift.movement.typeDrop",
  );
  const incoming = movement.type === "cash_in";
  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-(length:--density-text) font-semibold break-words">
          {t("posKasirShift.movement.rowTitle", {
            type,
            reason: movement.reasonNote,
          })}
        </p>
        <p className="text-base text-muted-foreground tabular">
          {t("posKasirShift.movement.rowMeta", {
            time: formatShiftTime(movement.recordedAt, timeZone),
            note: t("posKasirShift.movement.historyReasonRecorded"),
          })}
        </p>
      </div>
      <Money
        amount={incoming ? movement.amountIdr : -movement.amountIdr}
        className="font-semibold"
      />
    </li>
  );
}

function MovementHistory({ shiftId }: { shiftId: string }) {
  const t = useT();
  const movements = useCashMovements(shiftId);
  return (
    <section
      aria-labelledby="movement-history-title"
      className="grid gap-1 border-t-(length:--border-w) border-border pt-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="movement-history-title" className="type-title">
          {t("posKasirShift.movement.historyTitle")}
        </h3>
        <span className="text-base text-muted-foreground">
          {t("posKasirShift.movement.newestFirst")}
        </span>
      </div>
      {movements.isPending ? (
        <div aria-busy="true" className="grid gap-3 py-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : movements.isError ? (
        <ErrorState
          error={movements.error}
          title={t("posKasirShift.movement.historyErrorTitle")}
          description={t("posKasirShift.error.hint")}
          onRetry={() => void movements.refetch()}
        />
      ) : movements.data.length === 0 ? (
        <EmptyState
          title={t("posKasirShift.movement.historyEmptyTitle")}
          description={t("posKasirShift.movement.historyEmptyHint")}
        />
      ) : (
        <ul className="divide-y-(length:--border-w) divide-border">
          {movements.data.map((movement) => (
            <MovementRow key={movement.id} movement={movement} />
          ))}
        </ul>
      )}
    </section>
  );
}

// Cash in / cash out of the drawer: amount and reason are required. The new
// movement shows at the top of the history right after it is saved.
export function CashMovementPanel({ shiftId }: { shiftId: string }) {
  const t = useT();
  const record = useRecordCashMovement();
  const [type, setType] = useState<FormType>("cash_out");
  const [amountIdr, setAmountIdr] = useState(0);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ amount?: string; reason?: string }>(
    {},
  );
  // The movement just saved: the screen says it is recorded and not to enter it again.
  const [recorded, setRecorded] = useState<{
    type: FormType;
    amountIdr: number;
  } | null>(null);
  const out = type === "cash_out";

  function submit(event?: React.FormEvent) {
    event?.preventDefault();
    const next = {
      amount:
        amountIdr > 0 ? undefined : t("posKasirShift.movement.amountError"),
      reason:
        reason.trim().length >= MIN_REASON_LENGTH
          ? undefined
          : t("posKasirShift.movement.reasonError"),
    };
    setErrors(next);
    if (next.amount || next.reason) return;
    record.reset();
    record.mutate(
      { shiftId, type, amountIdr, reasonNote: reason.trim() },
      {
        onSuccess: () => {
          setRecorded({ type, amountIdr });
          setAmountIdr(0);
          setReason("");
        },
      },
    );
  }

  if (recorded)
    return (
      <PosPanel
        title={t("posKasirShift.movement.title")}
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                record.reset();
                setRecorded(null);
              }}
            >
              {t("posKasirShift.movement.recordAnother")}
            </Button>
            <Button asChild>
              <Link to="/pos">{t("posKasirShift.movement.backToPos")}</Link>
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <StateBlock
            mark="ok"
            role="status"
            aria-live="polite"
            title={t(
              recorded.type === "cash_out"
                ? "posKasirShift.movement.recordedTitleOut"
                : "posKasirShift.movement.recordedTitleIn",
            )}
            description={t("posKasirShift.movement.recordedBody")}
            amountIdr={recorded.amountIdr}
          >
            <p className="text-base text-muted-foreground">
              {t("posKasirShift.movement.recordedNoRepeat")}
            </p>
          </StateBlock>
          <MovementHistory shiftId={shiftId} />
        </div>
      </PosPanel>
    );

  return (
    <PosPanel
      title={t("posKasirShift.movement.title")}
      aside={
        <span className="text-base text-muted-foreground">
          {t("posKasirShift.movement.reasonRequiredNote")}
        </span>
      }
    >
      <div className="grid gap-4">
        <form onSubmit={submit} noValidate className="grid gap-4">
          <SegmentedControl<FormType>
            label={t("posKasirShift.movement.typeLabel")}
            selection="ink"
            value={type}
            onValueChange={(next) => {
              setType(next);
              record.reset();
              setErrors({});
            }}
            options={[
              { value: "cash_in", label: t("posKasirShift.movement.cashIn") },
              {
                value: "cash_out",
                label: t("posKasirShift.movement.cashOut"),
              },
            ]}
            className="w-full [&>*]:flex-1 [&>*]:justify-center"
          />
          <div className="grid gap-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
            <FormField
              label={t("posKasirShift.movement.amountLabel")}
              error={errors.amount}
              required
            >
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={formatRupiah(amountIdr)}
                onChange={(event) =>
                  setAmountIdr(parseDigits(event.target.value))
                }
                onFocus={(event) => event.currentTarget.select()}
                className="font-semibold tabular"
              />
            </FormField>
            <FormField
              label={t(
                out
                  ? "posKasirShift.movement.reasonLabelOut"
                  : "posKasirShift.movement.reasonLabelIn",
              )}
              error={errors.reason}
              required
            >
              <Textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={200}
              />
            </FormField>
          </div>
          {record.isError && (
            <ActionError
              title={t("posKasirShift.movement.errorTitle")}
              error={record.error}
              onRetry={() => submit()}
            />
          )}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <Button type="submit" loading={record.isPending}>
              {record.isPending
                ? t("posKasirShift.movement.saving")
                : t(
                    out
                      ? "posKasirShift.movement.submitOut"
                      : "posKasirShift.movement.submitIn",
                  )}
            </Button>
          </div>
        </form>
        <MovementHistory shiftId={shiftId} />
      </div>
    </PosPanel>
  );
}
