// Reusable supervisor override request (PRD v1.7 §3.6 "Override Supervisor",
// §4 Alur E, AUTH-06). Records reason code, reason and value, then gets the
// approver either from a PIN typed on this device or from the supervisor's
// phone through the approval service (create request, then poll it).
// The approver is never the requester (AUTH-06).
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, Clock, OctagonX, TimerOff } from "lucide-react";
import { idr } from "@starter/shared/core";
import type { OutletId } from "@starter/shared/core";
import type { PosOverrideAction } from "@starter/shared/access";
import type { StaffPinSwitch } from "@starter/shared/identity";
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
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  approvalOutcome,
  formatCountdown,
  parseRupiah,
  validateOverrideForm,
  type OverrideFormErrors,
} from "../logic.ts";
import {
  useApprovalRequestPolling,
  useCreateApprovalRequest,
} from "../hooks.ts";
import { usePinSession } from "../use-pin-session.ts";
import { useRoster } from "../storage.ts";
import { useClockMs } from "../use-clock.ts";
import { LockoutNotice } from "./lockout-notice.tsx";
import { PinPad } from "./pin-pad.tsx";

export const OVERRIDE_REASON_CODES = [
  "wrong_item",
  "customer_cancel",
  "out_of_stock",
  "quality_complaint",
  "price_mismatch",
  "other",
] as const;

export type OverrideResult = {
  method: "supervisor_pin" | "supervisor_phone";
  /** Known for a PIN approval; the phone path reports it on the request. */
  approverId: string | null;
  approverName: string | null;
  reasonCode: string;
  reason: string;
  valueIdr: number;
  approvalRequestId: string | null;
};

export type OverrideRequestModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: PosOverrideAction;
  /** snake_case object type, e.g. "order" (approval_requests.object_type). */
  objectType: string;
  objectId: string;
  outletId?: string;
  /** The signed-in staff member asking; a PIN from the same person is refused. */
  requesterId: string | null;
  defaultValueIdr?: number;
  onApproved: (result: OverrideResult) => void;
  onRejected?: (reason: string | null) => void;
};

type Method = "pin" | "phone";

export function OverrideRequestModal(props: OverrideRequestModalProps) {
  const t = useT();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent data-testid="override-modal" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("devicePin.override.title")}</DialogTitle>
          <DialogDescription>
            {t("devicePin.override.description")}
          </DialogDescription>
        </DialogHeader>
        {props.open && <ModalBody {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function ModalBody({
  onOpenChange,
  action,
  objectType,
  objectId,
  outletId,
  requesterId,
  defaultValueIdr,
  onApproved,
  onRejected,
}: OverrideRequestModalProps) {
  const t = useT();
  const [method, setMethod] = useState<Method>("pin");
  const [valueText, setValueText] = useState(
    defaultValueIdr === undefined ? "" : String(defaultValueIdr),
  );
  const [reasonCode, setReasonCode] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<OverrideFormErrors>({});
  const [requestId, setRequestId] = useState<string | null>(null);
  const [sendError, setSendError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Per-staff PIN verify (legend-dxb): the approver names themself first.
  const roster = useRoster();
  const [approverId, setApproverId] = useState<string | null>(null);

  const values = { valueText, reasonCode, reason };
  // A field's error goes away once that field is edited (not on the next PIN).
  function edited(field: keyof OverrideFormErrors) {
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }
  const create = useCreateApprovalRequest();

  function finish(
    result: Omit<OverrideResult, "reasonCode" | "reason" | "valueIdr">,
  ) {
    onApproved({
      ...result,
      reasonCode,
      reason: reason.trim(),
      valueIdr: parseRupiah(valueText) ?? 0,
    });
  }

  // Fail closed (AUTH-06): with no known requester the approver cannot be
  // told apart from them, so no PIN approves.
  const accept = useCallback(
    (result: StaffPinSwitch) =>
      requesterId === null
        ? t("devicePin.override.noRequester")
        : result.user.id === requesterId
          ? t("devicePin.override.sameApprover")
          : null,
    [requesterId, t],
  );
  const session = usePinSession({
    accept,
    userId: approverId,
    onVerified: (result) =>
      finish({
        method: "supervisor_pin",
        approverId: result.user.id,
        approverName: result.user.displayName,
        approvalRequestId: null,
      }),
  });

  // The pad completes on the sixth digit; the form must be valid first.
  const guardedPad = {
    ...session.padProps,
    onComplete: (pin: string) => {
      const found = validateOverrideForm(values);
      setErrors(found);
      if (Object.keys(found).length > 0) {
        setAttempt((n) => n + 1);
        // Empty the dots so the PIN can be typed again once the form is valid.
        session.clear();
        return;
      }
      session.submit(pin);
    },
  };

  function sendToPhone() {
    const found = validateOverrideForm(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSendError(false);
    create.mutate(
      {
        actionType: action,
        objectType,
        objectId,
        amountIdr: idr(parseRupiah(valueText) ?? 0),
        requestReason: reason.trim(),
        payload: { reasonCode },
        ...(outletId ? { outletId: outletId as OutletId } : {}),
      },
      {
        onSuccess: ({ data }) => setRequestId(data.id),
        onError: () => setSendError(true),
      },
    );
  }

  if (requestId !== null)
    return (
      <PhoneWait
        requestId={requestId}
        requesterId={requesterId}
        onApproved={(approvedBy) =>
          finish({
            method: "supervisor_phone",
            approverId: approvedBy,
            approverName: null,
            approvalRequestId: requestId,
          })
        }
        onRejected={(note) => onRejected?.(note)}
        onRetry={() => setRequestId(null)}
        onClose={() => onOpenChange(false)}
      />
    );

  return (
    <div className="grid gap-4">
      <p className="text-sm font-semibold">
        {t(`devicePin.override.action.${action}`)}
      </p>
      <FormField
        label={t("devicePin.override.valueLabel")}
        hint={t("devicePin.override.valueHint")}
        error={
          errors.value ? t("devicePin.override.field.valueRequired") : undefined
        }
        required
      >
        <Input
          inputMode="numeric"
          autoComplete="off"
          value={valueText}
          onChange={(event) => {
            setValueText(event.target.value);
            edited("value");
          }}
        />
      </FormField>
      <FormField
        label={t("devicePin.override.reasonCodeLabel")}
        error={
          errors.reasonCode
            ? t("devicePin.override.field.reasonCodeRequired")
            : undefined
        }
        required
      >
        <Select
          value={reasonCode}
          onValueChange={(code) => {
            setReasonCode(code);
            edited("reasonCode");
          }}
        >
          <SelectTrigger>
            <SelectValue
              placeholder={t("devicePin.override.reasonCodePlaceholder")}
            />
          </SelectTrigger>
          <SelectContent>
            {OVERRIDE_REASON_CODES.map((code) => (
              <SelectItem key={code} value={code}>
                {t(`devicePin.override.reasonCode.${code}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <FormField
        label={t("devicePin.override.reasonLabel")}
        hint={t("devicePin.override.reasonHint")}
        error={
          errors.reason
            ? t("devicePin.override.field.reasonRequired")
            : undefined
        }
        required
      >
        <Textarea
          rows={2}
          value={reason}
          placeholder={t("devicePin.override.reasonPlaceholder")}
          onChange={(event) => {
            setReason(event.target.value);
            edited("reason");
          }}
        />
      </FormField>

      <SegmentedControl<Method>
        label={t("devicePin.override.methodLabel")}
        value={method}
        onValueChange={setMethod}
        options={[
          { value: "pin", label: t("devicePin.override.method.pin") },
          { value: "phone", label: t("devicePin.override.method.phone") },
        ]}
      />

      {method === "pin" ? (
        <div className="grid gap-3" data-attempt={attempt}>
          <p className="text-sm text-muted-foreground">
            {t("devicePin.override.pinHint")}
          </p>
          {/* Per-staff PIN verify (legend-dxb): the approver is a named person. */}
          <FormField
            label={t("devicePin.override.approverLabel")}
            hint={
              roster.length === 0
                ? t("devicePin.override.approverEmpty")
                : t("devicePin.override.approverHint")
            }
            required
          >
            <Select
              value={approverId ?? ""}
              onValueChange={(value) => setApproverId(value || null)}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={t("devicePin.override.approverPlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                {roster.map((entry) => (
                  <SelectItem key={entry.userId} value={entry.userId}>
                    {entry.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          {session.lock.locked && (
            <LockoutNotice remainingMs={session.lock.remainingMs} />
          )}
          <PinPad
            {...guardedPad}
            shakeSignal={guardedPad.shakeSignal + attempt}
            clearSignal={guardedPad.clearSignal + attempt}
            active={approverId !== null}
            label={t("devicePin.override.pinTitle")}
          />
        </div>
      ) : (
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            {t("devicePin.override.phoneHint")}
          </p>
          {sendError && (
            <p role="alert" className="text-sm font-semibold text-danger">
              {t("devicePin.override.sendError")}
            </p>
          )}
          <Button onClick={sendToPhone} loading={create.isPending}>
            {create.isPending
              ? t("devicePin.override.sending")
              : t("devicePin.override.submitPhone")}
          </Button>
        </div>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {t("devicePin.override.cancel")}
        </Button>
      </DialogFooter>
    </div>
  );
}

function PhoneWait({
  requestId,
  requesterId,
  onApproved,
  onRejected,
  onRetry,
  onClose,
}: {
  requestId: string;
  requesterId: string | null;
  onApproved: (approvedBy: string | null) => void;
  onRejected: (reason: string | null) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const nowMs = useClockMs();
  const poll = useApprovalRequestPolling(requestId);
  const request = poll.data?.data ?? null;
  const raw =
    request && nowMs !== null ? approvalOutcome(request, nowMs) : "pending";
  // The server enforces requester != approver; the device checks it again and
  // fails closed when the approver is missing or is the requester (AUTH-06).
  const selfApproved =
    raw === "approved" &&
    (request?.decidedBy == null || request.decidedBy === requesterId);
  const outcome = selfApproved ? "rejected" : raw;

  const notified = useRef(false);
  useEffect(() => {
    if (!request || notified.current) return;
    if (outcome === "approved") {
      notified.current = true;
      onApproved(request.decidedBy);
    } else if (outcome === "rejected") {
      notified.current = true;
      onRejected(request.reason);
    }
  }, [outcome, request, onApproved, onRejected]);

  if (outcome === "pending")
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="override-pending"
        className="grid gap-3 text-center"
      >
        <Clock className="mx-auto size-10 text-info" aria-hidden="true" />
        <h3 className="type-heading">{t("devicePin.pending.title")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("devicePin.pending.body")}
        </p>
        {request && request.amountIdr !== null && (
          <Money
            amount={request.amountIdr}
            size="lg"
            className="justify-self-center"
          />
        )}
        {request && nowMs !== null && (
          <p className="tabular text-sm font-semibold">
            {t("devicePin.pending.remaining", {
              time: formatCountdown(Date.parse(request.deadlineAt) - nowMs),
            })}
          </p>
        )}
        {poll.isError && (
          <p className="text-sm text-warning">
            {t("devicePin.pending.pollError")}
          </p>
        )}
        <Button variant="outline" onClick={onClose}>
          {t("devicePin.pending.cancel")}
        </Button>
      </div>
    );

  const view = {
    approved: { Icon: CircleCheck, tone: "text-success" },
    rejected: { Icon: OctagonX, tone: "text-danger" },
    expired: { Icon: TimerOff, tone: "text-warning" },
    cancelled: { Icon: OctagonX, tone: "text-warning" },
  }[outcome];
  return (
    <div
      role="status"
      data-testid={`override-${outcome}`}
      className="grid gap-3 text-center"
    >
      <view.Icon
        className={`mx-auto size-10 ${view.tone}`}
        aria-hidden="true"
      />
      <h3 className="type-heading">
        {t(`devicePin.outcome.${outcome}.title`)}
      </h3>
      <p className="text-sm text-muted-foreground">
        {t(`devicePin.outcome.${outcome}.body`)}
      </p>
      {selfApproved && (
        <p className="text-sm font-semibold">
          {t("devicePin.override.sameApprover")}
        </p>
      )}
      {outcome === "rejected" && !selfApproved && request?.reason && (
        <p className="text-sm font-semibold">
          {t("devicePin.outcome.rejected.reasonPrefix", {
            reason: request.reason,
          })}
        </p>
      )}
      <DialogFooter>
        {outcome !== "approved" && (
          <Button onClick={onRetry}>{t("devicePin.outcome.retry")}</Button>
        )}
        <Button variant="outline" onClick={onClose}>
          {t("devicePin.override.close")}
        </Button>
      </DialogFooter>
    </div>
  );
}
