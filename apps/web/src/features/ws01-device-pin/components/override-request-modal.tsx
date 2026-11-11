// Reusable supervisor override request (PRD v1.7 §3.6 "Override Supervisor",
// §4 Alur E, AUTH-06). Records reason code, reason and value, then gets the
// approver either from a PIN typed on this device or from the supervisor's
// phone (POST /api/pos-overrides with supervisor_phone, then poll the linked
// approval request; "Berhenti menunggu" cancels it on the POS path).
// The approver is never the requester (AUTH-06).
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, Clock, OctagonX, TimerOff } from "lucide-react";
import { idr } from "@starter/shared/core";
import type { OutletId } from "@starter/shared/core";
import type { PosOverrideAction } from "@starter/shared/access";
import {
  posOverrideReasonCodes,
  posOverrideReasonCodeSchema,
  type CreatePosOverrideInput,
} from "@starter/shared/access/override";
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
  useCancelApprovalRequest,
  useCreatePhoneOverride,
} from "../hooks.ts";
import { createPosOverrideCall } from "../api.ts";
import { ApiError } from "@/lib/api/errors";
import { useTenantContext } from "@/lib/tenant-context";
import { resolveOverrideOutlet } from "../override-outlet.ts";
import { useRoster } from "../storage.ts";
import { usePinSession } from "../use-pin-session.ts";
import { useClockMs } from "../use-clock.ts";
import { LockoutNotice } from "./lockout-notice.tsx";
import { PinPad } from "./pin-pad.tsx";

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
  /** The outlet the requester's PIN session opened on; the device outlet stands in. */
  outletId?: string;
  /** Offered when no outlet is known: send the requester back to the PIN sign-in. */
  onRelogin?: () => void;
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
  outletId: savedOutletId,
  onRelogin,
  requesterId,
  defaultValueIdr,
  onApproved,
  onRejected,
}: OverrideRequestModalProps) {
  const t = useT();
  const deviceOutletId = useTenantContext().outlet?.id;
  const outletId =
    resolveOverrideOutlet(savedOutletId, deviceOutletId) ?? undefined;
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
  const create = useCreatePhoneOverride();
  // The server counts PIN misses per staff (AUTH-06), so the supervisor whose
  // PIN is being typed must be named. The roster is the mock/device list
  // (no eligible-approvers endpoint exists yet).
  const roster = useRoster();
  const [approverId, setApproverId] = useState<string | null>(null);

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
  // told apart from them, so no PIN is sent. The server checks it again.
  const precheck = useCallback(
    () =>
      requesterId === null
        ? t("devicePin.override.noRequester")
        : approverId === requesterId
          ? t("devicePin.override.sameApprover")
          : outletId
            ? null
            : t("devicePin.override.outletUnknown"),
    [requesterId, approverId, outletId, t],
  );
  // The PIN goes inside POST /api/pos-overrides (method supervisor_pin): the
  // server verifies it and records the approved override in one call.
  const session = usePinSession({
    mode: "override",
    userId: approverId,
    precheck,
    overrideCall: ({ userId, pin }) => {
      const code = posOverrideReasonCodeSchema.parse(reasonCode);
      const body: CreatePosOverrideInput = {
        outletId: outletId as OutletId,
        action,
        valueIdr: idr(parseRupiah(valueText) ?? 0),
        reason: reason.trim(),
        reasonCode: code,
        objectType,
        objectId,
        approval: { method: "supervisor_pin", approverUserId: userId, pin },
      };
      return createPosOverrideCall(body);
    },
    onVerified: (override) =>
      finish({
        method: "supervisor_pin",
        approverId: override.approvedBy,
        approverName:
          roster.find((entry) => entry.userId === override.approvedBy)
            ?.displayName ?? null,
        approvalRequestId: override.approvalRequestId,
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
    // The override is recorded at an outlet; without one the alert below
    // offers the PIN sign-in again.
    if (!outletId) return;
    setSendError(false);
    create.mutate(
      {
        outletId: outletId as OutletId,
        action,
        valueIdr: idr(parseRupiah(valueText) ?? 0),
        reason: reason.trim(),
        reasonCode: posOverrideReasonCodeSchema.parse(reasonCode),
        objectType,
        objectId,
        approval: { method: "supervisor_phone" },
      },
      {
        onSuccess: ({ data }) =>
          data.approvalRequestId === null
            ? setSendError(true)
            : setRequestId(data.approvalRequestId),
        onError: () => setSendError(true),
      },
    );
  }

  const outletAlert = !outletId && (
    <div role="alert" className="grid justify-items-start gap-2">
      <p className="text-sm font-semibold text-danger">
        {t("devicePin.override.outletUnknown")}
      </p>
      {onRelogin && (
        <Button variant="outline" size="sm" onClick={onRelogin}>
          {t("devicePin.override.relogin")}
        </Button>
      )}
    </div>
  );

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
            {posOverrideReasonCodes.map((code) => (
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
          <FormField label={t("devicePin.override.approverLabel")}>
            <Select
              value={approverId ?? undefined}
              onValueChange={(value) => setApproverId(value)}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={t("devicePin.override.approverLabel")}
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
          <p className="text-sm text-muted-foreground">
            {t("devicePin.override.pinHint")}
          </p>
          {outletAlert}
          {session.lock.locked && (
            <LockoutNotice remainingMs={session.lock.remainingMs} />
          )}
          <PinPad
            {...guardedPad}
            shakeSignal={guardedPad.shakeSignal + attempt}
            clearSignal={guardedPad.clearSignal + attempt}
            label={t("devicePin.override.pinTitle")}
          />
        </div>
      ) : (
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            {t("devicePin.override.phoneHint")}
          </p>
          {outletAlert}
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
  const cancel = useCancelApprovalRequest();
  const [cancelFailed, setCancelFailed] = useState(false);
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
        {cancelFailed && (
          <p role="alert" className="text-sm text-danger">
            {t("devicePin.pending.cancelError")}
          </p>
        )}
        {/* "Berhenti menunggu": withdraw the request first, then close. On 409
            the request was decided meanwhile: re-read it, so an approval takes
            the approved path and any other end shows its result. Any other
            failure keeps the modal open with an error (never close on a
            request that may still be approved). */}
        <Button
          variant="outline"
          loading={cancel.isPending}
          onClick={() => {
            setCancelFailed(false);
            cancel.mutate(requestId, {
              onSuccess: () => onClose(),
              onError: (error) => {
                if (error instanceof ApiError && error.status === 409) {
                  void poll.refetch().then((read) => {
                    const status = read.data?.data.status;
                    if (status === undefined || status === "pending")
                      setCancelFailed(true);
                  });
                  return;
                }
                setCancelFailed(true);
              },
            });
          }}
        >
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
